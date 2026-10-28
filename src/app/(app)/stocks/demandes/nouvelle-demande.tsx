"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, PackageSearch, Send, X } from "lucide-react";
import { creerDemandeStocks } from "@/lib/actions/demande-stocks-actions";
import { actionFailureMessage } from "@/lib/action-outcome";
import { developperDemande, produitsCouverts, type PorteurKam } from "@/lib/stocks/demande-stocks";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * LANCER UNE DEMANDE DE STOCKS (DO).
 *
 * L'aperçu en bas du formulaire est calculé par la MÊME fonction que l'action
 * (`developperDemande`) : ce que le DO lit avant d'envoyer — combien de KAM, combien de stocks,
 * quels établissements sans KAM — est exactement ce qui partira.
 */

interface Hopital { id: string; name: string; wilaya: string | null; porteurs: PorteurKam[] }
interface Produit { id: string; label: string }

const plier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function NouvelleDemandeStocks({ hopitaux, produits, produitsParBu, kams }: {
  hopitaux: Hopital[];
  produits: Produit[];
  produitsParBu: Record<string, string[]>;
  kams: Record<string, string>;
}) {
  const router = useRouter();
  const [ouvert, setOuvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recherche, setRecherche] = useState("");
  const [coches, setCoches] = useState<string[]>([]);
  const [wilayasOuvertes, setWilayasOuvertes] = useState<string[]>([]);
  const [produitsPar, setProduitsPar] = useState<Record<string, string[]>>({});
  const [communs, setCommuns] = useState<string[]>([]);
  const [choixOuvert, setChoixOuvert] = useState<string | null>(null);

  const parId = useMemo(() => new Map(hopitaux.map((h) => [h.id, h])), [hopitaux]);
  const libelle = useMemo(() => new Map(produits.map((p) => [p.id, p.label])), [produits]);
  const couverture = useMemo(() => new Map(hopitaux.map((h) => [h.id, h.porteurs])), [hopitaux]);
  const catalogue = useMemo(() => produits.map((p) => p.id), [produits]);

  const groupes = useMemo(() => {
    const q = plier(recherche.trim());
    const out = new Map<string, Hopital[]>();
    for (const h of hopitaux) {
      if (q && !plier(`${h.name} ${h.wilaya ?? ""}`).includes(q)) continue;
      const w = h.wilaya ?? "Sans wilaya";
      out.set(w, [...(out.get(w) ?? []), h]);
    }
    return [...out.entries()];
  }, [hopitaux, recherche]);

  const apercu = useMemo(() => developperDemande({
    hopitauxChoisis: coches,
    candidats: hopitaux.map((h) => h.id),
    produitsChoisis: Object.fromEntries(Object.entries(produitsPar).filter(([h]) => coches.includes(h))),
    produitsCommuns: coches.length === 0 ? communs : [],
    catalogue,
    couverture,
    produitsParBu,
  }), [coches, hopitaux, produitsPar, communs, catalogue, couverture, produitsParBu]);

  const basculer = (id: string) => setCoches((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const basculerWilaya = (w: string) => setWilayasOuvertes((v) => (v.includes(w) ? v.filter((x) => x !== w) : [...v, w]));
  const cocherGroupe = (liste: Hopital[]) => {
    const ids = liste.map((h) => h.id);
    const tous = ids.every((id) => coches.includes(id));
    setCoches((v) => (tous ? v.filter((x) => !ids.includes(x)) : [...new Set([...v, ...ids])]));
  };

  const nomsKams = (h: Hopital) => [...new Set(h.porteurs.map((p) => kams[p.kamId] ?? "—"))].join(", ");

  if (!ouvert) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => { setOuvert(true); setError(null); }}>
          <PackageSearch className="h-4 w-4" /> Nouvelle demande de stocks
        </Button>
      </div>
    );
  }

  return (
    <form
      className="surface space-y-4 p-3 sm:p-4"
      action={async (fd) => {
        setBusy(true); setError(null);
        for (const id of coches) fd.append("hopitalId", id);
        for (const id of coches) {
          for (const p of produitsPar[id] ?? []) { fd.append("produitHopitalId", id); fd.append("produitId", p); }
        }
        if (coches.length === 0) for (const p of communs) fd.append("produitCommunId", p);
        try {
          const r = await creerDemandeStocks(fd);
          if (!r.ok) { setError(r.error ?? "La demande de stocks n'a pas été créée."); return; }
          router.push(r.redirect ?? "/stocks/demandes");
        } catch {
          setError(actionFailureMessage("THROWN"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium"><PackageSearch className="h-4 w-4" /> Nouvelle demande de stocks</p>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOuvert(false)}><X className="h-4 w-4" /> Fermer</Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="space-y-1.5">
          <Label htmlFor="ds-titre">Titre</Label>
          <Input id="ds-titre" name="titre" required maxLength={180} placeholder="Ex. Stocks hôpitaux — comité du 15" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ds-echeance">Échéance</Label>
          <Input id="ds-echeance" name="echeance" type="date" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ds-notes">Consignes (facultatif)</Label>
        <Textarea id="ds-notes" name="notes" rows={2} placeholder="Ex. compter aussi la réserve de la pharmacie centrale" />
      </div>

      {/* ── LES ÉTABLISSEMENTS ─────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Établissements — {coches.length === 0 ? <strong>aucun coché = tous ({hopitaux.length})</strong> : <strong>{coches.length} coché{coches.length > 1 ? "s" : ""}</strong>}</Label>
          {coches.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => setCoches([])}>Tout décocher</Button>}
        </div>
        <Input value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Rechercher un établissement ou une wilaya…" aria-label="Rechercher un établissement" />
        <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
          {groupes.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Aucun établissement ne correspond.</p>}
          {groupes.map(([w, liste]) => {
            const ouverte = recherche.trim() !== "" || wilayasOuvertes.includes(w);
            const n = liste.filter((h) => coches.includes(h.id)).length;
            return (
              <div key={w} className="border-b border-border last:border-b-0">
                <div className="flex items-center justify-between gap-2 bg-secondary/40 px-3 py-1.5">
                  <button type="button" onClick={() => basculerWilaya(w)} className="flex min-h-9 min-w-0 items-center gap-1.5 text-left text-sm font-medium sm:min-h-0">
                    {ouverte ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="truncate">{w}</span>
                    <span className="text-xs font-normal text-muted-foreground">({n}/{liste.length})</span>
                  </button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => cocherGroupe(liste)}>
                    {liste.every((h) => coches.includes(h.id)) ? "Décocher" : "Tout cocher"}
                  </Button>
                </div>
                {ouverte && (
                  <ul>
                    {liste.map((h) => (
                      <li key={h.id}>
                        <label className="flex min-h-10 cursor-pointer items-start gap-2 px-3 py-2 text-sm hover:bg-secondary/40 sm:min-h-0 sm:py-1.5">
                          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={coches.includes(h.id)} onChange={() => basculer(h.id)} />
                          <span className="min-w-0">
                            <span className="block">{h.name}</span>
                            <span className={`block text-xs ${h.porteurs.length ? "text-muted-foreground" : "text-warning"}`}>
                              {h.porteurs.length ? `KAM : ${nomsKams(h)}` : "Sans KAM"}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── LES PRODUITS ───────────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        {coches.length === 0 ? (
          <>
            <Label>Produits — {communs.length === 0 ? <strong>aucun choisi = tous ceux que les KAM de chaque établissement portent</strong> : <strong>{communs.length} produit{communs.length > 1 ? "s" : ""}, là où un KAM les porte</strong>}</Label>
            <ChoixProduits produits={produits} choisis={communs} onChange={setCommuns} />
          </>
        ) : (
          <>
            <Label>Produits par établissement — aucun choisi = tous ceux que ses KAM portent</Label>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {coches.map((id) => {
                const h = parId.get(id);
                if (!h) return null;
                const choisis = produitsPar[id] ?? [];
                const tous = produitsCouverts(h.porteurs, catalogue, produitsParBu);
                return (
                  <li key={id} className="space-y-2 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm">
                        <span className="font-medium">{h.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {h.porteurs.length ? `KAM : ${nomsKams(h)}` : "Sans KAM"} · {choisis.length === 0 ? `tous (${tous.length})` : choisis.map((p) => libelle.get(p) ?? "—").join(", ")}
                        </span>
                      </span>
                      <span className="flex gap-1">
                        <Button type="button" size="sm" variant="outline" onClick={() => setChoixOuvert(choixOuvert === id ? null : id)}>
                          {choixOuvert === id ? "Fermer" : "Choisir les produits"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" aria-label={`Retirer ${h.name}`} onClick={() => basculer(id)}><X className="h-4 w-4" /></Button>
                      </span>
                    </div>
                    {choixOuvert === id && (
                      <ChoixProduits produits={produits} enAvant={tous} choisis={choisis}
                        onChange={(v) => setProduitsPar((m) => ({ ...m, [id]: v }))} />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* ── L'APERÇU : ce qui partira ──────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm">
        {apercu.ok ? (
          <>
            <p>
              <strong>{apercu.hopitaux.length}</strong> établissement{apercu.hopitaux.length > 1 ? "s" : ""} ·{" "}
              <strong>{apercu.lignes.filter((l) => l.kamIds.length > 0).length}</strong> stocks à renseigner ·{" "}
              <strong>{apercu.destinataires.length}</strong> KAM : {apercu.destinataires.map((k) => kams[k] ?? "—").join(", ")}
            </p>
            {apercu.hopitaux.some((h) => h.sansKam) && (
              <p className="mt-1 text-xs text-warning">
                Sans KAM ({apercu.hopitaux.filter((h) => h.sansKam).length}) — listés au suivi, adressés à personne :{" "}
                {apercu.hopitaux.filter((h) => h.sansKam).slice(0, 12).map((h) => parId.get(h.institutionId)?.name ?? "—").join(", ")}
                {apercu.hopitaux.filter((h) => h.sansKam).length > 12 ? "…" : ""}
              </p>
            )}
          </>
        ) : (
          <p className="text-warning">{apercu.error}</p>
        )}
      </div>

      {error && <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !apercu.ok}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer aux KAM
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setOuvert(false)}>Annuler</Button>
      </div>
    </form>
  );
}

/** Un choix de produits avec recherche ; `enAvant` = ceux que les KAM portent, listés d'abord. */
function ChoixProduits({ produits, choisis, onChange, enAvant }: {
  produits: Produit[];
  choisis: string[];
  onChange: (v: string[]) => void;
  enAvant?: string[];
}) {
  const [q, setQ] = useState("");
  const liste = useMemo(() => {
    const f = plier(q.trim());
    const filtres = produits.filter((p) => !f || plier(p.label).includes(f));
    if (!enAvant) return filtres;
    const avant = new Set(enAvant);
    return [...filtres.filter((p) => avant.has(p.id)), ...filtres.filter((p) => !avant.has(p.id))];
  }, [produits, q, enAvant]);
  const avant = new Set(enAvant ?? []);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un produit…" aria-label="Rechercher un produit" />
        {choisis.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>Aucun (= tous)</Button>}
      </div>
      <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
        {liste.map((p) => {
          const pris = choisis.includes(p.id);
          return (
            <button key={p.id} type="button"
              onClick={() => onChange(pris ? choisis.filter((x) => x !== p.id) : [...choisis, p.id])}
              className={`min-h-8 rounded-full border px-2.5 py-1 text-xs transition-colors ${pris ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"} ${enAvant && !avant.has(p.id) ? "opacity-70" : ""}`}
              title={enAvant && !avant.has(p.id) ? "Aucun KAM de cet établissement ne porte ce produit : la case sera « sans KAM »." : undefined}>
              {p.label}
            </button>
          );
        })}
        {liste.length === 0 && <span className="text-xs text-muted-foreground">Aucun produit ne correspond.</span>}
      </div>
    </div>
  );
}
