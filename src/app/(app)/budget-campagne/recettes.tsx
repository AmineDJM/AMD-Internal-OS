"use client";

import * as React from "react";
import { Lock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tuile } from "@/components/shared/tuile";
import { cn } from "@/lib/utils";
import { CLIENT_PAR_DEFAUT, MOIS_COURTS, calculerMontantRecette } from "@/lib/budget-campagne/recettes";
import { TAUX_TVA_PCT } from "@/lib/budget-campagne/impots";
import type { LigneRecetteVue, VueRecettes } from "@/lib/budget-campagne/recettes-requetes";
import { enregistrerRecetteCampagne, supprimerRecetteCampagne } from "@/lib/actions/budget-campagne-recettes-actions";
import { useActions, th, td, num, btn, btnPrimaire, champ, m } from "./commun";

type Vue = Extract<VueRecettes, { kind: "ok" }>;

const VIDE = { id: "", companyId: "", mois: "1", productId: "", businessUnitId: "", label: "", client: "", quantite: "", prixUnitaire: "", montant: "", tvaPct: "" };
type Saisie = typeof VIDE;
const nombre = (s: string) => { const t = s.replace(/\s/g, "").replace(",", "."); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : Number.NaN; };

/**
 * LE VOLET RECETTES DE LA CAMPAGNE — par société, une ligne par produit / BU et client, douze mois et le total. Le Super
 * Admin et la DG saisissent (un clic sur un mois ouvre la ligne) ; une direction lit. Rien n'est préchargé.
 */
export function VoletRecettes({ campaignId, vue }: { campaignId: string; vue: Vue }) {
  const { run, busy, info } = useActions();
  const modifiable = vue.droits.saisit && !vue.figeesLe;
  const [s, setS] = React.useState<Saisie>({ ...VIDE, companyId: vue.societes[0]?.id ?? "" });
  const maj = (p: Partial<Saisie>) => setS((x) => ({ ...x, ...p }));
  const cat = vue.catalogue;
  const produits = (cat?.produits ?? []).filter((p) => p.companyId === null || p.companyId === s.companyId);
  const bus = (cat?.bus ?? []).filter((b) => b.companyId === null || b.companyId === s.companyId);
  const produit = produits.find((p) => p.id === s.productId) ?? null;
  const apercu = calculerMontantRecette({ quantite: nombre(s.quantite), prixUnitaire: nombre(s.prixUnitaire) ?? produit?.prixHopital ?? null, montant: nombre(s.montant) });
  const societe = (id: string) => vue.societes.find((x) => x.id === id)?.label ?? "—";

  const ouvrir = (l: LigneRecetteVue) => setS({
    id: l.id, companyId: l.companyId, mois: String(l.mois), productId: l.productId ?? "", businessUnitId: l.businessUnitId ?? "",
    label: l.productId || l.businessUnitId ? "" : l.label, client: l.client === CLIENT_PAR_DEFAUT ? "" : l.client, quantite: l.quantite === null ? "" : String(l.quantite),
    prixUnitaire: l.sourcePrix === "SAISIE" && l.prixUnitaire !== null ? String(l.prixUnitaire) : "",
    montant: l.quantite === null ? String(l.montant) : "", tvaPct: l.tvaPct === null ? "" : String(l.tvaPct),
  });
  const enregistrer = () => void run(enregistrerRecetteCampagne, { ...s, campaignId, id: s.id || null })
    .then((r) => { if (r.ok) setS((x) => ({ ...VIDE, companyId: x.companyId, mois: x.mois === "ANNEE" ? "1" : x.mois })); });

  // Une ligne d'écran = une société, un produit (ou BU, ou libellé) et un client : la clé de rapprochement sans le mois.
  const rangees = React.useMemo(() => {
    const parRangee = new Map<string, { companyId: string; label: string; client: string; mois: (LigneRecetteVue | null)[]; total: number }>();
    for (const l of vue.lignes) {
      const [soc, , objet, client] = l.cle.split("|");
      const k = `${soc}|${objet}|${client}`;
      const r = parRangee.get(k) ?? { companyId: l.companyId, label: l.label, client: l.client, mois: Array.from({ length: 12 }, () => null), total: 0 };
      r.mois[l.mois - 1] = l;
      r.total += l.montant;
      parRangee.set(k, r);
    }
    return [...parRangee.values()];
  }, [vue.lignes]);

  return (
    <div className="space-y-4">
      {info && <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{info}</p>}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Tuile label={`Ventes ${vue.annee} (HT)`} valeur={m(vue.totaux.total)}
          contexte={vue.figeesLe ? `référence de l'exercice depuis le ${new Date(vue.figeesLe).toLocaleDateString("fr-FR")}` : undefined} />
        {vue.societes.slice(0, 3).map((x) => <Tuile key={x.id} label={x.label} valeur={m(vue.totaux.parSociete[x.id]?.total ?? 0)} />)}
      </div>

      {modifiable && (
        <section className="surface space-y-2 p-4" aria-label="Saisir une recette">
          <div className="flex flex-wrap items-end gap-2">
            <select className={champ} aria-label="Société" value={s.companyId} onChange={(e) => maj({ companyId: e.target.value, productId: "", businessUnitId: "" })}>
              {vue.societes.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <select className={champ} aria-label="Mois" value={s.mois} onChange={(e) => maj({ mois: e.target.value })} disabled={Boolean(s.id)}>
              {!s.id && <option value="ANNEE">Toute l&apos;année (÷ 12)</option>}
              {MOIS_COURTS.map((mo, i) => <option key={mo} value={String(i + 1)}>{mo}</option>)}
            </select>
            <select className={cn(champ, "max-w-56")} aria-label="Produit" value={s.productId}
              onChange={(e) => { const p = produits.find((x) => x.id === e.target.value); maj({ productId: e.target.value, businessUnitId: p?.businessUnitId ?? "" }); }}>
              <option value="">Produit —</option>
              {produits.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select className={cn(champ, "max-w-44")} aria-label="BU" value={s.businessUnitId} onChange={(e) => maj({ businessUnitId: e.target.value })}>
              <option value="">BU —</option>
              {bus.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
            {!s.productId && !s.businessUnitId && <input className={cn(champ, "w-40")} placeholder="Libellé" aria-label="Libellé" value={s.label} onChange={(e) => maj({ label: e.target.value })} />}
            <input className={cn(champ, "w-28")} placeholder="Client" aria-label="Client" value={s.client} onChange={(e) => maj({ client: e.target.value })} />
            <input className={cn(champ, "w-24")} inputMode="decimal" placeholder="Quantité" aria-label="Quantité" value={s.quantite} onChange={(e) => maj({ quantite: e.target.value })} />
            <input className={cn(champ, "w-28")} inputMode="decimal" aria-label="Prix unitaire" value={s.prixUnitaire} onChange={(e) => maj({ prixUnitaire: e.target.value })}
              placeholder={produit?.prixHopital ? `PU ${m(produit.prixHopital)}` : "Prix unitaire"} />
            <input className={cn(champ, "w-32")} inputMode="decimal" placeholder="ou montant" aria-label="Montant" value={s.montant} onChange={(e) => maj({ montant: e.target.value })} />
            <select className={champ} aria-label="TVA" value={s.tvaPct} onChange={(e) => maj({ tvaPct: e.target.value })}>
              <option value="">TVA {cat?.tvaDefaut ?? 19} % (défaut)</option>
              {TAUX_TVA_PCT.map((t) => <option key={t} value={String(t)}>TVA {t} %</option>)}
            </select>
            <button type="button" className={btnPrimaire} disabled={busy || !apercu.ok} onClick={enregistrer}>{s.id ? "Modifier" : "Ajouter"}</button>
            {s.id && <button type="button" className={btn} onClick={() => setS({ ...VIDE, companyId: s.companyId })}>Annuler</button>}
            {s.id && (
              <button type="button" className={btn} disabled={busy} aria-label="Retirer la recette"
                onClick={() => void run(supprimerRecetteCampagne, { id: s.id }, { confirmer: "Retirer cette recette prévue ?" }).then((r) => r.ok && setS({ ...VIDE, companyId: s.companyId }))}>
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{apercu.ok ? `${s.mois === "ANNEE" ? "Sur l'année" : "Ce mois"} : ${m(apercu.montant)} HT` : apercu.raison}</p>
        </section>
      )}
      {vue.droits.saisit && vue.figeesLe && <Badge tone="neutral" dot={false}><Lock className="h-3 w-3" /> Campagne close : recettes figées</Badge>}

      {vue.societes.map((x) => {
        const rs = rangees.filter((r) => r.companyId === x.id);
        if (rs.length === 0 && vue.societes.length > 1) return null;
        const t = vue.totaux.parSociete[x.id];
        return (
          <section key={x.id} className="surface overflow-hidden">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-base font-semibold">{x.label}</h2>
              <span className="text-sm tabular-nums">{m(t?.total ?? 0)}</span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr>
                  <th className={th}>Produit</th>
                  {MOIS_COURTS.map((mo) => <th key={mo} className={cn(th, num)}>{mo}</th>)}
                  <th className={cn(th, num)}>Total</th>
                </tr></thead>
                <tbody>
                  {rs.length === 0 && <tr><td className={td} colSpan={14}><span className="text-muted-foreground">Aucune recette prévue.{modifiable ? " Saisissez-la ci-dessus." : ""}</span></td></tr>}
                  {rs.map((r) => (
                    <tr key={`${r.label}|${r.client}`}>
                      <td className={td}>{r.label}{r.client !== CLIENT_PAR_DEFAUT && <span className="text-xs text-muted-foreground"> · {r.client}</span>}</td>
                      {r.mois.map((l, i) => (
                        <td key={i} className={cn(td, num)}>
                          {l && modifiable ? (
                            <button type="button" className="hover:underline" title={l.quantite !== null ? `${l.quantite} × ${m(l.prixUnitaire)}` : "montant direct"} onClick={() => ouvrir(l)}>{m(l.montant)}</button>
                          ) : l ? <span title={l.quantite !== null ? `${l.quantite} × ${m(l.prixUnitaire)}` : undefined}>{m(l.montant)}</span> : <span className="text-muted-foreground">—</span>}
                        </td>
                      ))}
                      <td className={cn(td, num, "font-medium")}>{m(r.total)}</td>
                    </tr>
                  ))}
                  {rs.length > 1 && t && (
                    <tr className="font-semibold">
                      <td className={td}>Total</td>
                      {t.mois.map((v, i) => <td key={i} className={cn(td, num)}>{m(v)}</td>)}
                      <td className={cn(td, num)}>{m(t.total)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {vue.societes.length > 1 && rangees.length === 0 && (
        <p className="surface p-6 text-center text-sm text-muted-foreground">Aucune recette prévue.{modifiable ? " Saisissez-la ci-dessus." : ""}</p>
      )}
    </div>
  );
}
