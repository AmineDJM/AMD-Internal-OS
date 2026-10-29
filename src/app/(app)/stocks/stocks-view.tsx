"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Plus, Trash2, Loader2, LineChart as LineChartIcon, Table2, Send, Link2 } from "lucide-react";
import { createStockHospital, deleteStockHospital, createStockAnnex, deleteStockAnnex, recordStockSnapshot, deleteStockSnapshot, requestStockState } from "@/lib/actions/stock-snapshot-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatDate } from "@/lib/utils";
import { STOCK_SCOPE_LABEL, type StockScope } from "@/lib/stocks/scopes";

export interface ProductOpt { id: string; label: string }
export interface LocationDTO { id: string; name: string }
/**
 * UN HÔPITAL DE L'ÉCRAN = un établissement de l'ANNUAIRE, avec ou sans lieu de stock (§118.134).
 *
 * `annexId` est nul tant qu'aucun relevé n'a visé l'établissement : le premier relevé crée le
 * lieu. `herite` marque un lieu créé à la main avant que l'annuaire ne soit la seule source ; il
 * n'est dans aucun secteur, donc invisible aux KAM, et le Super Admin le RATTACHE d'ici.
 */
export interface HospitalDTO {
  key: string;
  annexId: string | null;
  institutionId: string | null;
  name: string;
  wilaya: string | null;
  herite: boolean;
}
export interface InstitutionOpt { id: string; name: string; wilaya: string | null }
export interface UserOpt { id: string; label: string }
export interface SnapshotDTO {
  id: string;
  scope: string;
  annexId: string | null;
  productId: string;
  date: string;
  quantity: number;
  mine: boolean;
}
/** Le périmètre d'une personne qui ne voit PAS tout — pour le dire à l'écran, secteurs compris. */
export interface PerimetreDTO {
  mode: "BU" | "SECTEUR";
  secteurs: string[];
  /** La phrase quand il n'y a rien à montrer : ce qui manque, et où ça se règle. */
  explication: string | null;
}

type TabKey = StockScope;

const todayInput = () => new Date().toISOString().slice(0, 10);

export function StocksView({
  products, hospitals, institutionsDisponibles, annexes, snapshots, users, canRecord, canDelete, isSuperAdmin, canRequest, scopes, perimetre,
}: {
  products: ProductOpt[];
  hospitals: HospitalDTO[];
  /** Les établissements de l'annuaire encore SANS lieu de stock — ce que le Super Admin peut ajouter ou rattacher. */
  institutionsDisponibles: InstitutionOpt[];
  annexes: LocationDTO[];
  snapshots: SnapshotDTO[];
  users: UserOpt[];
  canRecord: boolean;
  canDelete: boolean;
  isSuperAdmin: boolean;
  canRequest: boolean;
  /**
   * LES ONGLETS AUXQUELS CETTE PERSONNE A DROIT — décidés par le serveur, jamais ici.
   *
   * Le terrain n'y voit que les hôpitaux : la centrale d'achat et ses annexes relèvent de la
   * chaîne d'approvisionnement. Les relevés correspondants ne sont pas non plus envoyés.
   */
  scopes: StockScope[];
  perimetre: PerimetreDTO | null;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const tabs = React.useMemo(() => scopes.map((k) => ({ key: k, label: STOCK_SCOPE_LABEL[k] })), [scopes]);
  // On ouvre sur le PREMIER onglet auquel on a droit — « PCH » en dur ouvrait sur un onglet
  // interdit, donc sur du vide, pour toute personne qui n'y a pas accès.
  const [tab, setTab] = React.useState<TabKey>(scopes[0] ?? "HOSPITAL");
  const [view, setView] = React.useState<"chart" | "table">("chart");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showRequest, setShowRequest] = React.useState(false);
  // Hôpitaux VISÉS par la demande d'état de stock (un ou plusieurs — pastilles à cocher). Une
  // demande vise un LIEU existant : un établissement jamais relevé n'a pas encore le sien.
  const demandables = React.useMemo(() => hospitals.filter((h) => h.annexId), [hospitals]);
  const [reqHospitals, setReqHospitals] = React.useState<string[]>([]);
  const toggleReqHospital = (id: string) =>
    setReqHospitals((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const isLocationTab = tab === "HOSPITAL" || tab === "ANNEX";
  // Sélection du lieu, propre à chaque onglet de lieux.
  const [hospitalKey, setHospitalKey] = React.useState<string>(hospitals[0]?.key ?? "");
  const [annexId, setAnnexId] = React.useState<string>(annexes[0]?.id ?? "");
  const hospital = React.useMemo(() => hospitals.find((h) => h.key === hospitalKey) ?? null, [hospitals, hospitalKey]);
  // Les relevés se lisent sur le LIEU ; un établissement sans lieu n'en a encore aucun.
  const locationId = tab === "HOSPITAL" ? (hospital?.annexId ?? "") : tab === "ANNEX" ? annexId : "";

  const scopedAll = React.useMemo(
    () => snapshots.filter((s) => s.scope === tab && (!isLocationTab || (!!locationId && s.annexId === locationId))),
    [snapshots, tab, isLocationTab, locationId],
  );
  const withData = React.useMemo(() => new Set(scopedAll.map((s) => s.productId)), [scopedAll]);

  const [productId, setProductId] = React.useState<string>(() => {
    const first = snapshots.find((s) => s.scope === scopes[0]);
    return first?.productId ?? products[0]?.id ?? "";
  });

  React.useEffect(() => {
    if (!hospitals.find((h) => h.key === hospitalKey)) setHospitalKey(hospitals[0]?.key ?? "");
  }, [hospitals, hospitalKey]);
  React.useEffect(() => {
    if (!annexes.find((a) => a.id === annexId)) setAnnexId(annexes[0]?.id ?? "");
  }, [annexes, annexId]);

  function switchTab(k: TabKey) {
    setTab(k); setError(null); setNotice(null);
    const loc = k === "HOSPITAL" ? (hospital?.annexId ?? "") : k === "ANNEX" ? annexId : "";
    const scoped = snapshots.filter((s) => s.scope === k && (!(k === "HOSPITAL" || k === "ANNEX") || s.annexId === loc));
    if (scoped.length > 0 && !scoped.some((s) => s.productId === productId)) setProductId(scoped[0].productId);
  }

  const series = React.useMemo(() => {
    const rows = scopedAll.filter((s) => s.productId === productId);
    return rows.map((s, i) => ({ ...s, label: formatDate(s.date), delta: i > 0 ? s.quantity - rows[i - 1].quantity : null }));
  }, [scopedAll, productId]);
  const last = series[series.length - 1];
  const productLabel = products.find((p) => p.id === productId)?.label ?? "";
  // Un hôpital se relève dès qu'il est CHOISI, lieu existant ou non : le premier relevé crée le lieu.
  const recordable = tab === "PCH" || (tab === "HOSPITAL" && !!hospital) || (tab === "ANNEX" && !!annexId);

  async function removeSnapshot(id: string) {
    if (!(await confirmer("Supprimer cet état de stock ?"))) return;
    const fd = new FormData(); fd.set("id", id);
    try {
      const r = await deleteStockSnapshot(fd);
      if (!r.ok) setError(r.error ?? "Échec de la suppression.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    }
    rafraichir();
  }

  async function removeHospital(h: HospitalDTO) {
    if (!h.annexId) return;
    if (!(await confirmer(`Retirer « ${h.name} » des lieux de stock et supprimer tous ses états de stock ? L'établissement reste dans l'annuaire.`))) return;
    const fd = new FormData(); fd.set("id", h.annexId);
    try {
      const r = await deleteStockHospital(fd);
      if (!r.ok) setError(r.error ?? "Échec de la suppression.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    }
    rafraichir();
  }

  async function removeAnnex(l: LocationDTO) {
    if (!(await confirmer(`Supprimer « ${l.name} » (annexe PCH) et tous ses états de stock ?`))) return;
    const fd = new FormData(); fd.set("id", l.id);
    try {
      const r = await deleteStockAnnex(fd);
      if (!r.ok) setError(r.error ?? "Échec de la suppression.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    }
    rafraichir();
  }

  /** Rattacher un lieu HÉRITÉ à un établissement de l'annuaire — le clic humain que le serveur refuse de deviner. */
  async function linkHospital(h: HospitalDTO, institutionId: string) {
    if (!h.annexId || !institutionId) return;
    setBusy(true); setError(null); setNotice(null);
    const fd = new FormData(); fd.set("annexId", h.annexId); fd.set("institutionId", institutionId);
    try {
      const r = await createStockHospital(fd);
      if (!r.ok) { setError(r.error ?? "Échec du rattachement."); return; }
      if (r.message) setNotice(r.message);
      rafraichir();
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  const herites = hospitals.filter((h) => h.herite).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex max-w-full flex-wrap gap-1 rounded-xl border border-border bg-muted/40 p-1">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => switchTab(t.key)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${tab === t.key ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {t.label}
            </button>
          ))}
        </div>
        {canRequest && (
          <Button type="button" size="sm" variant="outline" onClick={() => setShowRequest((v) => !v)}>
            <Send className="h-4 w-4" /> Demander un état de stock
          </Button>
        )}
      </div>

      {/* LE PÉRIMÈTRE, DIT : un KAM voit ses secteurs et les produits de sa BU, un National Sales
          toute sa BU. Sans cette ligne, une liste courte se lirait comme un module vide. */}
      {perimetre && (perimetre.secteurs.length > 0 || perimetre.mode === "BU") && !perimetre.explication && (
        <p className="text-xs text-muted-foreground" data-testid="perimetre-stock">
          {perimetre.mode === "BU"
            ? <>Votre périmètre : <span className="font-medium text-foreground">toute votre BU</span> — {perimetre.secteurs.length} secteur{perimetre.secteurs.length > 1 ? "s" : ""} ({perimetre.secteurs.join(", ")}), et les produits de la BU.</>
            : <>Votre périmètre : {perimetre.secteurs.length > 1 ? "vos secteurs" : "votre secteur"} <span className="font-medium text-foreground">{perimetre.secteurs.join(", ")}</span>, et les produits de votre BU.</>}
        </p>
      )}

      {/* Demande d'état de stock à un instant T (Direction / Super Admin) — un ou plusieurs
          HÔPITAUX ciblés + la personne chargée du relevé. */}
      {canRequest && showRequest && (
        <form
          action={async (fd) => {
            setBusy(true); setError(null);
            for (const id of reqHospitals) fd.append("hospitalIds", id);
            try {
              const r = await requestStockState(fd);
              if (r.ok) { setShowRequest(false); setReqHospitals([]); rafraichir(); } else setError(r.error ?? "La demande d'état de stock n'a pas été envoyée.");
            } catch {
              setError(actionFailureMessage("THROWN"));
            } finally {
              setBusy(false);
            }
          }}
          className="surface space-y-3 p-3 sm:p-4"
        >
          <div className="space-y-1.5">
            <Label>Hôpitaux concernés — un ou plusieurs (aucun = demande générale)</Label>
            {demandables.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun hôpital n&apos;a encore de lieu de stock (le Super Admin en ajoute depuis l&apos;annuaire dans l&apos;onglet « Stock hôpitaux »).</p>
            ) : (
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {demandables.map((h) => (
                  <button key={h.key} type="button" onClick={() => toggleReqHospital(h.annexId as string)}
                    className={`min-h-8 rounded-full border px-2.5 py-1 text-xs transition-colors ${reqHospitals.includes(h.annexId as string) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                    {h.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full min-w-0 flex-1 space-y-1.5 sm:w-auto sm:min-w-56 sm:max-w-xs">
              <Label htmlFor="req-assignee">Demander à</Label>
              <Select id="req-assignee" name="assigneeId" required defaultValue="">
                <option value="" disabled>Choisir une personne…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </Select>
            </div>
            <div className="w-full min-w-0 flex-[2] space-y-1.5 sm:w-auto sm:min-w-56">
              <Label htmlFor="req-note">Précision (produit / échéance…)</Label>
              <Input id="req-note" name="note" placeholder="Ex. Stock actuel d'Amoxival 500 — pour vendredi" />
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Envoyer la demande{reqHospitals.length > 0 ? ` (${reqHospitals.length} hôpital·aux)` : ""}
            </Button>
          </div>
        </form>
      )}

      {/* HÔPITAUX : les établissements de l'annuaire (de son secteur, de sa BU, ou tous) —
          sélection + ajout depuis l'annuaire (Super Admin) + rattachement des lieux hérités. */}
      {tab === "HOSPITAL" && (
        <div className="surface space-y-3 p-3 sm:p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Hôpitaux ({hospitals.length}){herites > 0 && isSuperAdmin ? ` — dont ${herites} hérité${herites > 1 ? "s" : ""} à rattacher à l'annuaire` : ""}
          </h2>
          {hospitals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground" data-testid="hopitaux-vide">
              {perimetre?.explication
                ?? (isSuperAdmin
                  ? "Aucun hôpital pour l'instant. Ajoutez-en un depuis l'annuaire des établissements ci-dessous."
                  : "Aucun hôpital n'a encore été ajouté depuis l'annuaire des établissements.")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {hospitals.map((h) => (
                <span key={h.key} className={`inline-flex items-center gap-1 rounded-full border px-1 py-1 text-sm ${hospitalKey === h.key ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}>
                  <button onClick={() => { setHospitalKey(h.key); setError(null); }} className="rounded-full px-2 py-0.5 hover:text-foreground" title={h.wilaya ? `Wilaya : ${h.wilaya}` : undefined}>
                    {h.name}
                    {h.wilaya && <span className="ml-1 text-xs text-muted-foreground">· {h.wilaya}</span>}
                    {h.herite && <span className="ml-1 rounded bg-amber-100 px-1 text-[0.6875rem] font-medium uppercase text-amber-800 dark:bg-amber-400/20 dark:text-amber-200">hérité</span>}
                  </button>
                  {isSuperAdmin && h.herite && institutionsDisponibles.length > 0 && (
                    <select
                      aria-label={`Rattacher « ${h.name} » à un établissement de l'annuaire`}
                      className="max-w-40 rounded-full border border-border bg-background px-1 py-0.5 text-base sm:text-xs"
                      defaultValue=""
                      disabled={busy}
                      onChange={(e) => { const v = e.target.value; if (v) void linkHospital(h, v); }}
                    >
                      <option value="">Rattacher à…</option>
                      {institutionsDisponibles.map((i) => <option key={i.id} value={i.id}>{i.name}{i.wilaya ? ` (${i.wilaya})` : ""}</option>)}
                    </select>
                  )}
                  {isSuperAdmin && h.annexId && (
                    <button onClick={() => removeHospital(h)} title="Retirer des lieux de stock (l'établissement reste dans l'annuaire)" className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {isSuperAdmin && (
            <form
              action={async (fd) => {
                setBusy(true); setError(null); setNotice(null);
                try {
                  const r = await createStockHospital(fd);
                  if (r.ok) { if (r.message) setNotice(r.message); rafraichir(); } else setError(r.error ?? "Le lieu de stock n'a pas été ajouté.");
                } catch {
                  setError(actionFailureMessage("THROWN"));
                } finally {
                  setBusy(false);
                }
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="w-full min-w-0 flex-1 space-y-1.5 sm:w-auto sm:min-w-64 sm:max-w-md">
                <Label htmlFor="stock-institution">Ajouter un hôpital de l&apos;annuaire</Label>
                <Select id="stock-institution" name="institutionId" required defaultValue="">
                  <option value="" disabled>{institutionsDisponibles.length === 0 ? "Tous les établissements de l'annuaire ont déjà leur lieu de stock" : "Choisir un établissement…"}</option>
                  {institutionsDisponibles.map((i) => <option key={i.id} value={i.id}>{i.name}{i.wilaya ? ` — ${i.wilaya}` : ""}</option>)}
                </Select>
              </div>
              <Button type="submit" size="sm" disabled={busy || institutionsDisponibles.length === 0}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter</Button>
              <p className="basis-full text-xs text-muted-foreground">
                <Link2 className="mr-1 inline h-3 w-3" />
                Les hôpitaux du module Stocks sont ceux de l&apos;annuaire des établissements : un établissement absent se crée d&apos;abord dans Annuaires › Établissements.
              </p>
            </form>
          )}
        </div>
      )}

      {/* ANNEXES PCH : des lieux nommés librement (Super Admin) — une annexe n'est pas un établissement. */}
      {tab === "ANNEX" && (
        <div className="surface space-y-3 p-3 sm:p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Annexes PCH ({annexes.length})</h2>
          {annexes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
              {isSuperAdmin ? "Aucune annexe PCH pour l'instant. Créez la première ci-dessous." : "Aucune annexe PCH n'a encore été créée par le Super Admin."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {annexes.map((l) => (
                <span key={l.id} className={`inline-flex items-center gap-1 rounded-full border px-1 py-1 text-sm ${annexId === l.id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}>
                  <button onClick={() => { setAnnexId(l.id); setError(null); }} className="rounded-full px-2 py-0.5 hover:text-foreground">{l.name}</button>
                  {isSuperAdmin && (
                    <button onClick={() => removeAnnex(l)} title="Supprimer (annexe PCH)" className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {isSuperAdmin && (
            <form
              action={async (fd) => {
                setBusy(true); setError(null);
                try {
                  const r = await createStockAnnex(fd);
                  if (r.ok) rafraichir(); else setError(r.error ?? "L'annexe n'a pas été ajoutée.");
                } catch {
                  setError(actionFailureMessage("THROWN"));
                } finally {
                  setBusy(false);
                }
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="w-full min-w-0 flex-1 space-y-1.5 sm:w-auto sm:min-w-48 sm:max-w-xs">
                <Label htmlFor="location-name">Nouvelle annexe PCH</Label>
                <Input id="location-name" name="name" placeholder="Ex. Annexe Blida" required />
              </div>
              <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter</Button>
            </form>
          )}
        </div>
      )}

      {notice && <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{notice}</p>}

      {/* Vue par produit (graphique / tableau) — dès qu'un lieu est sélectionnable */}
      {isLocationTab && !recordable ? (
        error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null
      ) : (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-full min-w-0 flex-1 space-y-1.5 sm:w-auto sm:min-w-56 sm:max-w-md">
              <Label htmlFor="stock-product">Produit</Label>
              {products.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="produits-vide">Aucun produit dans votre périmètre : le stock ne se relève que pour les produits de votre BU rattachés à un dossier Regulatory.</p>
              ) : (
                <Select id="stock-product" value={productId} onChange={(e) => { setProductId(e.target.value); setError(null); }}>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.label}{withData.has(p.id) ? "" : " — aucun relevé ici"}</option>)}
                </Select>
              )}
            </div>
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
              <button onClick={() => setView("chart")} title="Vue graphique" className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${view === "chart" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}>
                <LineChartIcon className="h-4 w-4" /> Graphique
              </button>
              <button onClick={() => setView("table")} title="Vue tableau" className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ${view === "table" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}>
                <Table2 className="h-4 w-4" /> Tableau
              </button>
            </div>
          </div>

          {canRecord && productId && recordable && (
            <form
              action={async (fd) => {
                setBusy(true); setError(null);
                fd.set("scope", tab);
                if (tab === "HOSPITAL" && hospital) {
                  // Le lieu s'il existe ; sinon l'établissement, et le serveur crée le lieu.
                  if (hospital.annexId) fd.set("annexId", hospital.annexId);
                  else if (hospital.institutionId) fd.set("institutionId", hospital.institutionId);
                }
                if (tab === "ANNEX") fd.set("annexId", annexId);
                fd.set("productId", productId);
                try {
                  const r = await recordStockSnapshot(fd);
                  if (r.ok) rafraichir(); else setError(r.error ?? "L'état de stock n'a pas été enregistré.");
                } catch {
                  setError(actionFailureMessage("THROWN"));
                } finally {
                  setBusy(false);
                }
              }}
              className="surface flex flex-wrap items-end gap-3 p-3 sm:p-4"
            >
              <div className="min-w-0 flex-1 space-y-1.5 sm:flex-none">
                <Label htmlFor="snap-date">Date de l&apos;état</Label>
                <Input id="snap-date" name="date" type="date" defaultValue={todayInput()} required />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5 sm:flex-none">
                <Label htmlFor="snap-qty">Quantité restante</Label>
                <Input id="snap-qty" name="quantity" type="number" inputMode="numeric" min="0" step="1" placeholder="Ex. 1200" required className="w-full tabular-nums sm:w-36" />
              </div>
              <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Enregistrer l&apos;état
              </Button>
              <p className="basis-full text-xs text-muted-foreground sm:basis-auto sm:flex-1">
                Un seul état par jour et par produit : ressaisir la même date corrige la valeur.
              </p>
            </form>
          )}

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          {series.length === 0 ? (
            <EmptyState
              icon="Boxes"
              title="Aucun état de stock pour ce produit ici"
              description={canRecord ? "Enregistrez un premier état (date + quantité restante) : la courbe se construira au fil des relevés." : "Les états de stock apparaîtront ici."}
            />
          ) : (
            <>
              <div className="flex flex-wrap gap-3 text-sm">
                <div className="surface flex min-w-0 items-center gap-2 px-3 py-2">
                  <span className="min-w-0">Dernier état : <span className="font-semibold">{formatNumber(last.quantity)}</span> u. le {formatDate(last.date)}</span>
                  {(canDelete || last.mine) && (
                    <button onClick={() => removeSnapshot(last.id)} title="Supprimer ce dernier état de stock"
                      className="rounded-md p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive sm:p-1">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="surface px-3 py-2 text-muted-foreground">{series.length} relevé·s — {productLabel}</div>
              </div>
              {(canDelete || series.some((s) => s.mine)) && (
                <p className="text-xs text-muted-foreground">Astuce : ouvrez la vue <span className="font-medium">Tableau</span> pour supprimer n&apos;importe quel relevé (icône corbeille en fin de ligne).</p>
              )}

              {view === "chart" ? (
                <div className="surface p-2 sm:p-4">
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={series} margin={{ top: 10, right: 14, left: -4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f6" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="#94a3b8" />
                      <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="#94a3b8" width={52} allowDecimals={false}
                        tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)} />
                      <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12 }}
                        formatter={(v: number) => [v.toLocaleString("fr-FR"), "Quantité"]} />
                      <Line type="monotone" dataKey="quantity" name="Quantité" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="surface overflow-x-auto p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Quantité restante</TableHead>
                        <TableHead className="text-right">Évolution</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...series].reverse().map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium text-muted-foreground sm:font-normal" data-sans-etiquette>{formatDate(s.date)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{formatNumber(s.quantity)}</TableCell>
                          <TableCell className={`text-right ${s.delta === null ? "text-muted-foreground" : s.delta < 0 ? "text-destructive" : "text-emerald-600"}`}>
                            {s.delta === null ? "—" : `${s.delta > 0 ? "+" : ""}${formatNumber(s.delta)}`}
                          </TableCell>
                          <TableCell className="text-right">
                            {(canDelete || s.mine) && (
                              <button onClick={() => removeSnapshot(s.id)} title="Supprimer cet état" aria-label="Supprimer cet état" className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
