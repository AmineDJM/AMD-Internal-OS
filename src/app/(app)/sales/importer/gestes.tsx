"use client";

import * as React from "react";
import { Loader2, Upload, CheckCircle2, AlertCircle, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { formatNumber } from "@/lib/utils";
import { moisCourt } from "@/lib/ventes-pch/calculs";
import {
  apercuFichiersVentesPch, appliquerFichiersVentesPch, rattacherEtablissementVentesPch, rattacherPosteVentesPch,
  reglerFournisseurVentesPch, enregistrerDrVentesPch,
} from "@/lib/actions/ventes-pch-actions";
import type { Apercu } from "@/lib/ventes-pch/service";
import type { EtablissementARattacher, PosteARattacher, FournisseursProduit, DirectionRegionale } from "@/lib/ventes-pch/requetes";

function Erreur({ texte }: { texte: string | null }) {
  if (!texte) return null;
  return <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" /> {texte}</div>;
}

// ─────────────────────────── Téléverser ───────────────────────────

/** Le mois / l'année proposés d'office pour un fichier : ceux lus sur ses dates (« annuel » quand il couvre plusieurs mois). */
function periodeParDefaut(a: Apercu): ChoixPeriodeEcran {
  const d = a.detectee;
  const unMois = !d.annuel && d.debut === d.fin;
  return { annee: d.debut.slice(0, 4), mois: unMois ? String(Number(d.debut.slice(5, 7))) : "annuel" };
}

const MOIS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

interface ChoixPeriodeEcran { annee: string; mois: string }

function libelleDetectee(a: Apercu): string {
  const d = a.detectee;
  if (d.annuel) return `année ${d.debut.slice(0, 4)}`;
  return d.debut === d.fin ? moisCourt(d.debut) : `${moisCourt(d.debut)} → ${moisCourt(d.fin)}`;
}

function CarteApercu({ a, choix, onChoix, disabled }: { a: Apercu; choix: ChoixPeriodeEcran; onChoix: (c: ChoixPeriodeEcran) => void; disabled: boolean }) {
  const ventes = a.nature === "VENTES_DR";
  const anneeCourante = new Date().getFullYear();
  const annees = Array.from(new Set([...Array.from({ length: 7 }, (_, k) => String(anneeCourante - 5 + k)), choix.annee])).sort();
  return (
    <div className="surface space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{a.nomFichier}</span>
        <Badge tone="info">{ventes ? `Ventes ${a.sources.join(", ")}` : "Réceptions PCH"}</Badge>
        <Badge tone="neutral">{a.periode.libelle}{a.periode.annuel ? " · annuel" : ""}</Badge>
        {a.deja && <Badge tone="warning">déjà importé le {new Date(a.deja.le).toLocaleDateString("fr-FR")}</Badge>}
      </div>
      {/* LA PÉRIODE DU FICHIER, à confirmer ou corriger : c'est elle qui décide quel mois (par DR) le fichier remplace. */}
      {!a.deja && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Période du fichier :</span>
          <Select aria-label="Mois" value={choix.mois} disabled={disabled} onChange={(e) => onChoix({ ...choix, mois: e.target.value })} className="h-9 w-auto text-xs sm:h-8">
            <option value="annuel">annuel</option>
            {MOIS_LONGS.map((m, k) => <option key={m} value={String(k + 1)}>{m}</option>)}
          </Select>
          <Select aria-label="Année" value={choix.annee} disabled={disabled} onChange={(e) => onChoix({ ...choix, annee: e.target.value })} className="h-9 w-auto text-xs sm:h-8">
            {annees.map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
          {a.choisie && <span className="text-muted-foreground">(choisie — lue : {libelleDetectee(a)})</span>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <span>{formatNumber(a.lignes)} lignes</span>
        {ventes ? (
          <>
            <span>{formatNumber(a.etablissements)} établissements · {formatNumber(a.etablissementsARattacher)} à rattacher</span>
            <span className={a.nonServies ? "text-warning" : ""}>{formatNumber(a.nonServies)} lignes non servies ({formatNumber(a.quantiteNonServie)} boîtes)</span>
            <span>{formatNumber(a.retours)} retours</span>
          </>
        ) : (
          <>
            <span>{formatNumber(a.fournisseurs)} fournisseurs</span>
            <span>{Object.entries(a.parType).map(([t, k]) => `${t} ${formatNumber(k)}`).join(" · ")}</span>
            <span />
          </>
        )}
      </div>
      {a.produits.length > 0 && (
        <p className="text-xs"><span className="text-muted-foreground">Nos produits : </span>{a.produits.slice(0, 10).map((p) => `${p.nom} (${formatNumber(p.quantite)}${p.nonServi ? ` · non servi ${formatNumber(p.nonServi)}` : ""})`).join(" · ")}{a.produits.length > 10 ? ` · +${a.produits.length - 10}` : ""}</p>
      )}
      {a.produits.length === 0 && <p className="text-xs text-muted-foreground">Aucun de nos produits reconnu.</p>}
      {a.postesARattacher > 0 && <p className="text-xs text-warning">{a.postesARattacher} poste(s) de nos molécules à rattacher</p>}
      {a.remplace.length > 0 && <p className="text-xs text-muted-foreground">Remplace : {[...new Set(a.remplace.map((r) => r.source))].join(", ")} — {a.remplace.map((r) => moisCourt(r.mois)).filter((v, i, t) => t.indexOf(v) === i).join(", ")}</p>}
      {a.sansDate > 0 && <p className="text-xs text-muted-foreground">{formatNumber(a.sansDate)} lignes sans facture (non servies) rattachées à {moisCourt(a.periode.fin)}</p>}
    </div>
  );
}

/** DÉPOSER un ou plusieurs fichiers PCH → APERÇU (rien n'est écrit) → APPLIQUER. */
export function TeleverserPch() {
  const { enCours, rafraichir } = useRafraichir();
  const [fichiers, setFichiers] = React.useState<File[]>([]);
  const [apercus, setApercus] = React.useState<Apercu[] | null>(null);
  const [erreurs, setErreurs] = React.useState<{ nomFichier: string; error: string }[]>([]);
  const [resultats, setResultats] = React.useState<{ nomFichier: string; message: string; ok: boolean }[] | null>(null);
  const [occupe, setOccupe] = React.useState<"analyse" | "application" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  /** Le mois / l'année choisis par fichier ; absent = ceux lus sur les dates du fichier. */
  const [choix, setChoix] = React.useState<Record<string, ChoixPeriodeEcran>>({});
  const choixDe = (a: Apercu) => choix[a.nomFichier] ?? periodeParDefaut(a);

  /** Seules les périodes qui DIFFÈRENT de la lecture du fichier partent au serveur (`periodes`, JSON par nom de fichier). */
  const formulaire = (liste: File[], periodes: Record<string, ChoixPeriodeEcran>) => {
    const fd = new FormData();
    for (const f of liste) fd.append("fichiers", f);
    const aEnvoyer: Record<string, { annee: string; mois: string }> = {};
    for (const f of liste) {
      const c = periodes[f.name];
      const a = apercus?.find((x) => x.nomFichier === f.name);
      if (c && (!a || c.annee !== periodeParDefaut(a).annee || c.mois !== periodeParDefaut(a).mois)) aEnvoyer[f.name] = c;
    }
    if (Object.keys(aEnvoyer).length) fd.set("periodes", JSON.stringify(aEnvoyer));
    return fd;
  };
  const analyser = async (liste: File[]) => {
    setErr(null); setResultats(null); setApercus(null); setErreurs([]); setChoix({});
    if (!liste.length) return;
    setOccupe("analyse");
    try {
      const r = await apercuFichiersVentesPch(formulaire(liste, {}));
      if (!r.ok) { setErr(r.error); return; }
      setApercus(r.apercus); setErreurs(r.erreurs);
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };
  /** Le mois ou l'année d'un fichier change : son aperçu se relit sous cette période (ce qu'elle remplace se met à jour). */
  const choisir = async (a: Apercu, c: ChoixPeriodeEcran) => {
    const f = fichiers.find((x) => x.name === a.nomFichier);
    const suivant = { ...choix, [a.nomFichier]: c };
    setChoix(suivant);
    if (!f) return;
    setErr(null); setOccupe("analyse");
    try {
      const r = await apercuFichiersVentesPch(formulaire([f], suivant));
      if (!r.ok) { setErr(r.error); return; }
      const nouveau = r.apercus[0];
      if (nouveau) setApercus((liste) => liste?.map((x) => (x.nomFichier === a.nomFichier ? nouveau : x)) ?? null);
      if (r.erreurs[0]) setErr(`${r.erreurs[0].nomFichier} : ${r.erreurs[0].error}`);
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };
  const appliquer = async () => {
    const aAppliquer = fichiers.filter((f) => apercus?.some((a) => a.nomFichier === f.name && !a.deja));
    if (!aAppliquer.length) return;
    setErr(null); setOccupe("application");
    try {
      const r = await appliquerFichiersVentesPch(formulaire(aAppliquer, choix));
      if (!r.ok) { setErr(r.error); return; }
      setResultats(r.resultats); setApercus(null); setFichiers([]); setChoix({});
      rafraichir();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };
  const nouveaux = apercus?.filter((a) => !a.deja).length ?? 0;

  return (
    <div className="space-y-3">
      <label className="surface flex cursor-pointer flex-col items-center justify-center gap-2 border-dashed p-6 text-center text-sm text-muted-foreground hover:bg-secondary/40">
        <Upload className="h-5 w-5" />
        <span>Déposer les fichiers PCH (VENTEDR*.xls, Reception*.xlsx…) — un ou plusieurs</span>
        <input
          type="file" multiple accept=".xls,.xlsx" className="sr-only"
          onChange={(e) => { const l = Array.from(e.target.files ?? []); setFichiers(l); void analyser(l); e.target.value = ""; }}
        />
      </label>
      {occupe === "analyse" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lecture de {fichiers.length} fichier(s)…</p>}
      <Erreur texte={err} />
      {erreurs.map((e) => <Erreur key={e.nomFichier} texte={`${e.nomFichier} : ${e.error}`} />)}
      {apercus && apercus.length > 0 && (
        <div className="space-y-2">
          {apercus.map((a) => <CarteApercu key={a.empreinte} a={a} choix={choixDe(a)} onChoix={(c) => void choisir(a, c)} disabled={occupe !== null || enCours} />)}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => { setApercus(null); setFichiers([]); }} className="w-full sm:w-auto">Annuler</Button>
            <Button onClick={appliquer} disabled={!nouveaux || occupe !== null || enCours} className="w-full sm:w-auto">
              {occupe === "application" && <Loader2 className="h-4 w-4 animate-spin" />} Appliquer {nouveaux} fichier{nouveaux > 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}
      {resultats && (
        <ul className="space-y-1 text-sm">
          {resultats.map((r) => (
            <li key={r.nomFichier} className={`flex items-start gap-2 ${r.ok ? "" : "text-destructive"}`}>
              {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="min-w-0 [overflow-wrap:anywhere]"><b>{r.nomFichier}</b> — {r.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────── Établissements à rattacher ───────────────────────────

export function RattacherEtablissements({ liste, etablissements, peutModifier }: {
  liste: EtablissementARattacher[];
  etablissements: { id: string; nom: string; wilaya: string | null }[];
  peutModifier: boolean;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const libelle = (e: { nom: string; wilaya: string | null }) => (e.wilaya ? `${e.nom} — ${e.wilaya}` : e.nom);
  const parLibelle = React.useMemo(() => new Map(etablissements.map((e) => [libelle(e), e.id])), [etablissements]);
  const [saisies, setSaisies] = React.useState<Record<string, string>>({});
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const rattacher = async (cle: string, institutionId: string | null) => {
    if (!institutionId) { setErr("Choisissez un établissement de la liste."); return; }
    setErr(null); setOccupe(cle);
    const fd = new FormData(); fd.set("cle", cle); fd.set("institutionId", institutionId);
    try {
      const r = await rattacherEtablissementVentesPch(fd);
      if (!r.ok) setErr(r.error ?? "L'établissement n'a pas été rattaché."); else rafraichir();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };
  if (!liste.length) return <p className="text-sm text-muted-foreground">Tous les clients des DR sont rattachés à l&apos;annuaire.</p>;
  return (
    <div className="space-y-2">
      <Erreur texte={err} />
      <datalist id="pch-etablissements">{etablissements.map((e) => <option key={e.id} value={libelle(e)} />)}</datalist>
      <div className="surface overflow-x-auto">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Client PCH</TableHead>
              <TableHead>DR</TableHead>
              <TableHead className="text-right">Lignes</TableHead>
              <TableHead>Établissement de l&apos;annuaire</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {liste.map((l) => (
              <TableRow key={l.cle}>
                <TableCell className="sticky left-0 z-10 min-w-[220px] bg-card [overflow-wrap:anywhere]">{l.client}</TableCell>
                <TableCell className="text-muted-foreground">{l.drs.join(", ")}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(l.lignes)}</TableCell>
                <TableCell className="min-w-[320px]">
                  {peutModifier ? (
                    <div className="space-y-1.5">
                      {l.suggestions.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {l.suggestions.map((s) => (
                            <button key={s.id} type="button" disabled={occupe !== null || enCours} onClick={() => rattacher(l.cle, s.id)} className="rounded-full border border-border px-2 py-1 text-xs hover:border-primary hover:text-primary sm:py-0.5">
                              {libelle(s)}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        <Input list="pch-etablissements" placeholder="Chercher un établissement…" value={saisies[l.cle] ?? ""} onChange={(e) => setSaisies({ ...saisies, [l.cle]: e.target.value })} className="h-9 text-xs sm:h-8" />
                        <Button size="sm" variant="outline" disabled={occupe !== null || enCours || !saisies[l.cle]} onClick={() => rattacher(l.cle, parLibelle.get(saisies[l.cle] ?? "") ?? null)}>
                          {occupe === l.cle ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rattacher"}
                        </Button>
                      </div>
                    </div>
                  ) : <span className="text-muted-foreground">à rattacher</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─────────────────────────── Postes de nos molécules ───────────────────────────

const STATUT_POSTE: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "info" }> = {
  MEMOIRE: { label: "confirmé", tone: "success" },
  IDENTITE: { label: "reconnu", tone: "info" },
  AMBIGU: { label: "ambigu", tone: "warning" },
  MOLECULE: { label: "à rattacher", tone: "warning" },
  MARCHE: { label: "marché", tone: "neutral" },
};

export function RattacherPostes({ postes, peutModifier }: { postes: PosteARattacher[]; peutModifier: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [choix, setChoix] = React.useState<Record<number, string>>({});
  const [occupe, setOccupe] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const enregistrer = async (poste: number, productId: string) => {
    setErr(null); setOccupe(poste);
    const fd = new FormData(); fd.set("poste", String(poste)); fd.set("productId", productId);
    try {
      const r = await rattacherPosteVentesPch(fd);
      if (!r.ok) setErr(r.error ?? "Le poste n'a pas été rattaché."); else rafraichir();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };
  if (!postes.length) return <p className="text-sm text-muted-foreground">Aucun poste PCH de nos molécules pour l&apos;instant.</p>;
  return (
    <div className="space-y-2">
      <Erreur texte={err} />
      <div className="surface overflow-x-auto">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Poste PCH</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Notre produit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {postes.map((p) => {
              const st = STATUT_POSTE[p.statut] ?? STATUT_POSTE.MARCHE;
              const valeur = choix[p.poste] ?? p.productId ?? "";
              return (
                <TableRow key={p.poste}>
                  <TableCell className="sticky left-0 z-10 min-w-[260px] bg-card [overflow-wrap:anywhere]">
                    <span className="font-mono text-xs text-muted-foreground">{p.poste}</span> {p.designation}
                  </TableCell>
                  <TableCell><Badge tone={st.tone}>{st.label}</Badge></TableCell>
                  <TableCell className="min-w-[300px]">
                    {peutModifier ? (
                      <div className="flex gap-1.5">
                        <Select value={valeur} onChange={(e) => setChoix({ ...choix, [p.poste]: e.target.value })} className="h-9 text-xs sm:h-8">
                          <option value="">— Aucun de nos produits —</option>
                          {p.candidats.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                        </Select>
                        <Button size="sm" variant="outline" disabled={occupe !== null || enCours || (valeur === (p.productId ?? "") && p.manuel)} onClick={() => enregistrer(p.poste, valeur)}>
                          {occupe === p.poste ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmer"}
                        </Button>
                      </div>
                    ) : (p.produit ?? <span className="text-muted-foreground">—</span>)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─────────────────────────── Fournisseurs « à nous » ───────────────────────────

export function FournisseursNous({ liste, peutModifier }: { liste: FournisseursProduit[]; peutModifier: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [ajouts, setAjouts] = React.useState<Record<string, string>>({});
  const [err, setErr] = React.useState<string | null>(null);
  const regler = async (productId: string, fournisseur: string, actif: boolean) => {
    setErr(null); setOccupe(`${productId}|${fournisseur}`);
    const fd = new FormData(); fd.set("productId", productId); fd.set("fournisseur", fournisseur); fd.set("actif", actif ? "on" : "off");
    try {
      const r = await reglerFournisseurVentesPch(fd);
      if (!r.ok) setErr(r.error ?? "Le fournisseur n'a pas été enregistré."); else { setAjouts({ ...ajouts, [productId]: "" }); rafraichir(); }
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  };
  if (!liste.length) return <p className="text-sm text-muted-foreground">Aucun produit rattaché à un poste PCH pour l&apos;instant.</p>;
  return (
    <div className="space-y-2">
      <Erreur texte={err} />
      <div className="surface overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Produit</TableHead>
              <TableHead>Fournisseurs de la PCH (réceptions FO) — cochés : nous</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {liste.map((p) => (
              <TableRow key={p.productId}>
                <TableCell className="sticky left-0 z-10 min-w-[180px] bg-card font-medium">{p.nom}</TableCell>
                <TableCell className="min-w-[380px]">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {p.livreurs.length === 0 && <span className="text-xs text-muted-foreground">aucune réception</span>}
                    {p.livreurs.map((l) => (
                      <label key={l.cle} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox" className="h-4 w-4" checked={l.nous}
                          disabled={!peutModifier || occupe !== null || enCours}
                          onChange={(e) => regler(p.productId, l.fournisseur, e.target.checked)}
                        />
                        <span className={l.nous ? "font-medium" : "text-muted-foreground"}>{l.fournisseur}</span>
                        <span className="tabular-nums text-muted-foreground">{formatNumber(l.qte)}</span>
                        {l.origine === "AUTO" && l.nous && <Badge tone="info">proposé</Badge>}
                      </label>
                    ))}
                  </div>
                  {peutModifier && (
                    <div className="mt-1.5 flex max-w-md gap-1.5">
                      <Input placeholder="Ajouter un fournisseur (nom PCH)…" value={ajouts[p.productId] ?? ""} onChange={(e) => setAjouts({ ...ajouts, [p.productId]: e.target.value })} className="h-9 text-xs sm:h-8" />
                      <Button size="sm" variant="outline" disabled={!ajouts[p.productId]?.trim() || occupe !== null || enCours} onClick={() => regler(p.productId, ajouts[p.productId]!.trim(), true)}>Ajouter</Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─────────────────────────── Directions régionales ───────────────────────────

export function DirectionsRegionalesPch({ drs, peutModifier }: { drs: DirectionRegionale[]; peutModifier: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  if (!drs.length) return <p className="text-sm text-muted-foreground">Les directions régionales apparaissent au premier fichier de ventes importé.</p>;
  return (
    <div className="space-y-2">
      <Erreur texte={err} />
      <div className="surface overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Code</TableHead>
              <TableHead>Libellé</TableHead>
              <TableHead>Wilayas</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {drs.map((d) => (
              <TableRow key={d.code}>
                <TableCell className="sticky left-0 z-10 bg-card font-mono text-xs">{d.code}</TableCell>
                <TableCell colSpan={peutModifier ? 3 : 1} className="min-w-[480px]">
                  {peutModifier ? (
                    <form
                      className="flex flex-col gap-1.5 sm:flex-row"
                      action={async (fd) => {
                        setErr(null); setOccupe(d.code);
                        fd.set("code", d.code);
                        try {
                          const r = await enregistrerDrVentesPch(fd);
                          if (!r.ok) setErr(r.error ?? "La direction régionale n'a pas été enregistrée."); else rafraichir();
                        } catch {
                          setErr(actionFailureMessage("THROWN"));
                        } finally {
                          setOccupe(null);
                        }
                      }}
                    >
                      <Input name="libelle" defaultValue={d.libelle} placeholder="DR Oran" className="h-9 text-xs sm:h-8 sm:w-48" />
                      <Input name="wilayas" defaultValue={d.wilayas.join(", ")} placeholder="Oran, Tlemcen, …" className="h-9 text-xs sm:h-8" />
                      <Button type="submit" size="sm" variant="outline" disabled={occupe !== null || enCours}>{occupe === d.code ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enregistrer"}</Button>
                    </form>
                  ) : d.libelle}
                </TableCell>
                {!peutModifier && <TableCell className="text-muted-foreground">{d.wilayas.join(", ") || "—"}</TableCell>}
                {!peutModifier && <TableCell />}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
