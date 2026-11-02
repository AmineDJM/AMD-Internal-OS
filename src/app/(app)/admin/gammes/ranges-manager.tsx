"use client";

import * as React from "react";
import {
  Loader2, Plus, Pencil, Trash2, ChevronDown, Package, Users, X, Search, Building2,
} from "lucide-react";
import {
  createProductRange, updateProductRange, deleteProductRange,
  setProductsRange, setUserRanges, removeProductFromRange,
} from "@/lib/actions/product-range-actions";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useAction, useKeyedAction } from "@/components/shared/use-action";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/labels";
import { describeAttachment, type CompanyRangeTree, type RangeNode } from "@/lib/org/product-ranges";
import { cn } from "@/lib/utils";

export interface ProductOption {
  id: string;
  label: string;
  companyId: string | null;
  rangeId: string | null;
}

export interface PersonRow {
  id: string;
  name: string;
  role: string;
  /** Sociétés ouvertes EN ENTIER (appartenance + autorisation d'entité). */
  companyIds: string[];
  rangeIds: string[];
}

const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#475569"];

/**
 * L'ARBRE ENTITÉ › GAMME › PRODUITS, et le rattachement des personnes.
 *
 * Une entité par bloc, ses gammes dedans, les produits d'une gamme derrière sa flèche. On ne
 * déplie qu'une chose à la fois : sur un téléphone, tout déplié, l'écran devient illisible.
 */
export function RangesManager({
  tree, products, people,
}: {
  tree: CompanyRangeTree[];
  products: ProductOption[];
  people: PersonRow[];
}) {
  // Les gestes de l'arbre (retirer un produit, supprimer une gamme) n'ont pas de place où parler :
  // un refus part en avis flottant.
  const ligne = useKeyedAction({ signalerErreurs: true });
  const [openRange, setOpenRange] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ range: RangeNode | null; companyId: string; companyLabel: string } | null>(null);
  const [picking, setPicking] = React.useState<{ range: RangeNode; companyLabel: string } | null>(null);
  const [person, setPerson] = React.useState<PersonRow | null>(null);

  const labelOf = React.useCallback(
    (companyId: string) => tree.find((t) => t.companyId === companyId)?.companyLabel ?? "—",
    [tree],
  );
  const rangeById = React.useMemo(() => {
    const m = new Map<string, { range: RangeNode; companyLabel: string }>();
    for (const c of tree) for (const r of c.ranges) m.set(r.id, { range: r, companyLabel: c.companyLabel });
    return m;
  }, [tree]);

  async function removeOne(productId: string) {
    const fd = new FormData();
    fd.set("productId", productId);
    await ligne.run(`retirer-${productId}`, async () => {
      const r = await removeProductFromRange(fd);
      return r.ok ? r : { ok: false, error: r.error ?? "Le produit n'a pas été retiré de la gamme." };
    });
  }

  async function drop(range: RangeNode) {
    const fd = new FormData();
    fd.set("id", range.id);
    await ligne.run(`supprimer-${range.id}`, async () => {
      const r = await deleteProductRange(fd);
      return r.ok ? r : { ok: false, error: r.error ?? "La gamme n'a pas été supprimée." };
    }, {
      confirmer: `Supprimer la gamme « ${range.name} » ?\n\nSes ${range.productCount} produit(s) NE SONT PAS supprimés : ils redeviennent « sans gamme ». Les ${range.memberCount} rattachement(s) de personnes sont levés.`,
    });
  }

  return (
    <div className="space-y-6">
      {/* ─────────── L'ARBRE ─────────── */}
      <div className="space-y-3">
        {tree.map((company) => (
          <section key={company.companyId} className="surface overflow-hidden p-0">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
              <span className="flex h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: company.color ?? "#94a3b8" }} />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{company.companyLabel}</h2>
              <span className="text-[0.6875rem] text-muted-foreground">
                {company.ranges.length} gamme{company.ranges.length > 1 ? "s" : ""}
                {company.unranged > 0 && ` · ${company.unranged} produit(s) sans gamme`}
              </span>
              <Button
                size="sm" variant="outline"
                onClick={() => setEditing({ range: null, companyId: company.companyId, companyLabel: company.companyLabel })}
              >
                <Plus className="h-4 w-4" /> Gamme
              </Button>
            </header>

            {company.ranges.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground sm:px-4">
                Aucune gamme. Sans gamme, cette entité se rattache en entier : qui y a droit voit tous ses produits.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {company.ranges.map((r) => {
                  const opened = openRange === r.id;
                  const inRange = products.filter((p) => p.rangeId === r.id);
                  return (
                    <li key={r.id}>
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
                        <button
                          type="button"
                          onClick={() => setOpenRange(opened ? null : r.id)}
                          aria-expanded={opened}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", opened ? "" : "-rotate-90")} />
                          <span className="flex h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.color ?? company.color ?? "#94a3b8" }} />
                          <span className="min-w-0 truncate text-sm font-medium">{r.name}</span>
                          {!r.isActive && <Badge tone="neutral">Inactive</Badge>}
                        </button>
                        <span className="flex shrink-0 items-center gap-3 text-[0.6875rem] text-muted-foreground">
                          <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" />{r.productCount}</span>
                          <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{r.memberCount}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => setPicking({ range: r, companyLabel: company.companyLabel })}>
                            <Plus className="h-4 w-4" /> Produits
                          </Button>
                          <Button
                            size="sm" variant="ghost" aria-label={`Modifier ${r.name}`}
                            onClick={() => setEditing({ range: r, companyId: company.companyId, companyLabel: company.companyLabel })}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" aria-label={`Supprimer ${r.name}`} onClick={() => drop(r)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </span>
                      </div>

                      {opened && (
                        <div className="border-t border-border bg-secondary/20 px-3 py-2 sm:px-4">
                          {inRange.length === 0 ? (
                            <p className="py-2 text-sm text-muted-foreground">
                              Aucun produit. « Produits » ouvre la liste de Regulatory pour en ranger ici.
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {inRange.map((p) => (
                                <li key={p.id} className="flex items-center gap-2 text-xs">
                                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                                  <button
                                    type="button" onClick={() => removeOne(p.id)}
                                    aria-label={`Retirer ${p.label} de la gamme`}
                                    title="Retirer de la gamme (le dossier reste)"
                                    className="shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary hover:text-destructive sm:p-1"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>

      {/* ─────────── LES PERSONNES ─────────── */}
      <PeoplePanel people={people} labelOf={labelOf} rangeById={rangeById} onPick={setPerson} />

      {editing && (
        <RangeSheet
          key={editing.range?.id ?? `new-${editing.companyId}`}
          range={editing.range}
          companyId={editing.companyId}
          companyLabel={editing.companyLabel}
          onClose={() => setEditing(null)}
        />
      )}
      {picking && (
        <ProductPicker
          range={picking.range}
          companyLabel={picking.companyLabel}
          products={products}
          onClose={() => setPicking(null)}
        />
      )}
      {person && (
        <PersonSheet person={person} tree={tree} onClose={() => setPerson(null)} />
      )}
    </div>
  );
}

/** La liste des personnes et ce à quoi chacune est rattachée. */
function PeoplePanel({
  people, labelOf, rangeById, onPick,
}: {
  people: PersonRow[];
  labelOf: (companyId: string) => string;
  rangeById: Map<string, { range: RangeNode; companyLabel: string }>;
  onPick: (p: PersonRow) => void;
}) {
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? people.filter((p) => p.name.toLowerCase().includes(needle)) : people;

  return (
    <section className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Rattachement des personnes</h2>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une personne…" className="pl-8" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Une personne rattachée à une <strong>entité</strong> voit toute la société. Rattachée à des
        <strong> gammes</strong>, elle ne voit que leurs produits — et une gamme lui ouvre l&apos;entité
        qui la porte, sans quoi le rattachement n&apos;ouvrirait rien.
      </p>

      <ul className="divide-y divide-border">
        {shown.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{p.name}</span>
              <span className="block truncate text-[0.6875rem] text-muted-foreground">
                {ROLE_LABELS[p.role] ?? p.role}
              </span>
            </span>
            <span className="flex min-w-0 flex-[2] flex-wrap gap-1">
              {p.companyIds.map((c) => (
                <Badge key={c} tone="info">
                  <Building2 className="h-3 w-3" /> {describeAttachment(labelOf(c))}
                </Badge>
              ))}
              {p.rangeIds.map((id) => {
                const found = rangeById.get(id);
                return (
                  <Badge key={id} tone="success">
                    {found ? describeAttachment(found.companyLabel, found.range.name) : "Gamme supprimée"}
                  </Badge>
                );
              })}
              {p.companyIds.length === 0 && p.rangeIds.length === 0 && (
                <span className="text-[0.6875rem] text-muted-foreground">Aucun rattachement — voit selon ses seuls droits de module.</span>
              )}
            </span>
            <Button size="sm" variant="outline" onClick={() => onPick(p)}>Gammes</Button>
          </li>
        ))}
        {shown.length === 0 && <li className="py-4 text-sm text-muted-foreground">Personne ne correspond.</li>}
      </ul>
    </section>
  );
}

/** Création / modification d'une gamme. */
function RangeSheet({
  range, companyId, companyLabel, onClose,
}: {
  range: RangeNode | null;
  companyId: string;
  companyLabel: string;
  onClose: () => void;
}) {
  const { busy, err, run } = useAction();
  const [color, setColor] = React.useState(range?.color ?? PALETTE[0]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("color", color);
    await run(async () => {
      const r = range
        ? await updateProductRange((fd.set("id", range.id), fd))
        : await createProductRange(undefined, (fd.set("companyId", companyId), fd));
      return r.ok ? r : { ok: false, error: r.error ?? "La gamme n'a pas été enregistrée." };
    }, onClose);
  }

  return (
    <Sheet
      open onClose={onClose}
      title={range ? `Modifier « ${range.name} »` : `Nouvelle gamme — ${companyLabel}`}
      description={range ? undefined : "Une gamme appartient à une entité et regroupe ses produits."}
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor="range-name">Nom de la gamme</Label>
          <Input id="range-name" name="name" defaultValue={range?.name ?? ""} required placeholder="Cardiologie" className="mt-1" />
        </div>
        <div>
          <Label htmlFor="range-desc">Description (facultatif)</Label>
          <Textarea id="range-desc" name="description" rows={2} className="mt-1" />
        </div>
        <div>
          <Label>Couleur</Label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c} type="button" onClick={() => setColor(c)} aria-label={`Couleur ${c}`}
                className={cn("h-7 w-7 rounded-full border-2", color === c ? "border-foreground" : "border-transparent")}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        {range && (
          <label className="flex items-center gap-2 text-sm">
            {/* LE TÉMOIN CACHÉ, AVANT la case : décochée, c'est lui qui dit « non » (§118.172). */}
            <input type="hidden" name="isActive" value="off" />
            <input type="checkbox" name="isActive" defaultChecked={range.isActive} className="h-4 w-4" />
            Gamme active
          </label>
        )}

        <Retour ton="erreur">{err}</Retour>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {range ? "Enregistrer" : "Créer la gamme"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * LE CHOIX DES PRODUITS — ceux de Regulatory, filtrés sur l'entité de la gamme.
 *
 * On ne propose PAS les produits d'une autre société : les ranger ici ouvrirait le dossier à
 * des gens d'ailleurs sans qu'aucun écran d'entité ne le montre. Les produits sans entité,
 * eux, sont proposés — les ranger leur donne justement celle de la gamme.
 */
function ProductPicker({
  range, companyLabel, products, onClose,
}: {
  range: RangeNode;
  companyLabel: string;
  products: ProductOption[];
  onClose: () => void;
}) {
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState<Set<string>>(new Set(products.filter((p) => p.rangeId === range.id).map((p) => p.id)));
  const { busy, err, run } = useAction();

  const eligible = products.filter((p) => !p.companyId || p.companyId === range.companyId);
  const needle = q.trim().toLowerCase();
  const shown = needle ? eligible.filter((p) => p.label.toLowerCase().includes(needle)) : eligible;

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  async function save() {
    // Ce qu'on ENLÈVE et ce qu'on AJOUTE sont deux gestes : la case décochée d'un produit
    // qui était dans la gamme doit l'en sortir, pas seulement ne rien faire.
    const before = new Set(products.filter((p) => p.rangeId === range.id).map((p) => p.id));
    const added = [...sel].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !sel.has(id));

    await run(async () => {
      if (added.length) {
        const fd = new FormData();
        fd.set("rangeId", range.id);
        added.forEach((id) => fd.append("productId", id));
        const r = await setProductsRange(fd);
        if (!r.ok) return { ok: false, error: r.error ?? "Les produits n'ont pas été ajoutés à la gamme." };
      }
      if (removed.length) {
        const fd = new FormData();
        fd.set("rangeId", "");
        removed.forEach((id) => fd.append("productId", id));
        const r = await setProductsRange(fd);
        if (!r.ok) return { ok: false, error: r.error ?? "Les produits décochés n'ont pas été sortis de la gamme." };
      }
      return { ok: true };
    }, onClose);
  }

  return (
    <Sheet
      open onClose={onClose} width="lg"
      title={`Produits — ${companyLabel} › ${range.name}`}
      description="Les produits sont ceux de Regulatory. Seuls ceux de cette entité (et ceux qui n'en ont pas encore) sont proposés."
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un produit (DCI, référence, marque)…" className="pl-8" />
        </div>
        <p className="text-xs text-muted-foreground">{sel.size} sélectionné(s) sur {eligible.length} éligible(s)</p>

        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {shown.map((p) => {
            const other = p.rangeId && p.rangeId !== range.id;
            return (
              <li key={p.id}>
                <label className="flex cursor-pointer items-start gap-2 px-3 py-2.5 text-sm hover:bg-secondary/40 sm:py-2">
                  <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words line-clamp-2 sm:truncate">{p.label}</span>
                    {other && <span className="block text-[0.6875rem] text-warning">Déjà dans une autre gamme — le cocher le déplacera.</span>}
                    {!p.companyId && <span className="block text-[0.6875rem] text-muted-foreground">Sans entité — le ranger lui donnera celle de la gamme.</span>}
                  </span>
                </label>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-3 py-4 text-sm text-muted-foreground">Aucun produit ne correspond.</li>}
        </ul>

        <Retour ton="erreur">{err}</Retour>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Le rattachement d'une personne aux gammes — toutes entités confondues. */
function PersonSheet({ person, tree, onClose }: { person: PersonRow; tree: CompanyRangeTree[]; onClose: () => void }) {
  const [sel, setSel] = React.useState<Set<string>>(new Set(person.rangeIds));
  const { busy, err, run } = useAction();

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  async function save() {
    const fd = new FormData();
    fd.set("userId", person.id);
    [...sel].forEach((id) => fd.append("rangeId", id));
    await run(async () => {
      const r = await setUserRanges(fd);
      return r.ok ? r : { ok: false, error: r.error ?? "Les gammes de cette personne n'ont pas été enregistrées." };
    }, onClose);
  }

  return (
    <Sheet
      open onClose={onClose} width="lg"
      title={`Gammes de ${person.name}`}
      description="Cochez les gammes que cette personne suit, de n'importe quelle entité. Aucune case cochée : elle relève de ses entités, et voit tout ce qui en relève."
    >
      <div className="space-y-3">
        {tree.map((c) => {
          const whole = person.companyIds.includes(c.companyId);
          return (
            <div key={c.companyId} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <span className="flex h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? "#94a3b8" }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.companyLabel}</span>
                {whole && <Badge tone="info">Entité entière</Badge>}
              </div>
              {whole && (
                <p className="px-3 pt-2 text-[0.6875rem] text-muted-foreground">
                  Cette personne a déjà la société <strong>en entier</strong> : cocher une gamme d&apos;ici
                  ne la restreindra pas — on ne retire pas un droit donné plus haut. Retirez d&apos;abord
                  son accès à l&apos;entité (écran « Accès ») pour la limiter à une gamme.
                </p>
              )}
              {c.ranges.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">Aucune gamme dans cette entité.</p>
              ) : (
                <ul className="p-2">
                  {c.ranges.map((r) => (
                    <li key={r.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/40">
                        <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{r.productCount} produit(s)</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        <Retour ton="erreur">{err}</Retour>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
