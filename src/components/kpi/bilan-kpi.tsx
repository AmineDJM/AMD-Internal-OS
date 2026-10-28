"use client";

import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn, formatDate } from "@/lib/utils";
import { NATURE_LABELS } from "@/lib/kpi/briques";
import type { BilanKpi, KpiDuBilan, LigneDetail } from "@/lib/kpi/types";
import {
  bilanKpi, commentaireLunaKpi, declarerKpi, deciderDeclarationKpi, origineKpi, proposerNiveauKpi, signerRevueKpi, validerEvaluationKpi,
} from "@/lib/actions/kpi-actions";
import { LIBELLE_STATUT_REVUE, PastilleKpi, SparklineKpi, couleurScore } from "./kpi-commun";
import { sansBloquer } from "@/lib/journal";

/**
 * LE BILAN D'UNE PERSONNE — le même écran pour le manager (panneau de Mon équipe) et pour la personne (Mon bilan).
 * En continu : les valeurs bougent tant que la période vit. Le manager y tranche (niveau d'un KPI évalué, déclaration,
 * signature) ; la personne y déclare, avec sa pièce. Une revue signée est figée : ses lignes ne bougent plus.
 */
export function BilanKpiVue({ userId, periodeInitiale, bilanInitial, onChange }: {
  userId: string;
  periodeInitiale?: string | null;
  bilanInitial?: BilanKpi | null;
  onChange?: () => void;
}) {
  const [bilan, setBilan] = React.useState<BilanKpi | null>(bilanInitial ?? null);
  const [periode, setPeriode] = React.useState<string>(bilanInitial?.periode.cle ?? periodeInitiale ?? "");
  const [chargement, setChargement] = React.useState(!bilanInitial);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const recharger = React.useCallback(async (p: string) => {
    setChargement(true);
    const r = await bilanKpi(userId, p).catch(sansBloquer("bilan-kpi.BilanKpiVue.bilanKpi", null));
    setChargement(false);
    if (r?.ok) { setBilan(r.bilan); setPeriode(r.bilan.periode.cle); } else setMsg({ ok: false, texte: r && !r.ok ? r.error : "Le bilan n'a pas pu se charger." });
  }, [userId]);

  React.useEffect(() => {
    if (!bilanInitial) void recharger(periodeInitiale ?? "");
  }, [bilanInitial, periodeInitiale, recharger]);

  const apres = async (r: { ok: boolean; error?: string; message?: string } | null) => {
    setMsg(r ? { ok: r.ok, texte: r.ok ? r.message ?? "Enregistré." : r.error ?? "Échec." } : { ok: false, texte: "Échec." });
    if (r?.ok) { await recharger(periode); onChange?.(); }
  };

  if (chargement && !bilan) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</p>;
  if (!bilan) return <p className="text-sm text-destructive">{msg?.texte ?? "Bilan indisponible."}</p>;

  const manager = bilan.droits.manager && !bilan.figee;
  const evalues = bilan.kpis.filter((k) => k.nature === "EVALUE");
  const declares = bilan.kpis.filter((k) => k.nature === "DECLARE");
  const chiffres = bilan.kpis.filter((k) => k.nature !== "EVALUE" && k.nature !== "DECLARE");
  const statut = LIBELLE_STATUT_REVUE[bilan.revue.statut];

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <PastilleKpi couleur={couleurScore(bilan.score)} className="min-w-[3.5rem] py-1 text-base">{bilan.score ?? "—"}</PastilleKpi>
          <div className="min-w-0">
            <p className="font-medium">
              Score {bilan.figee ? "signé" : "provisoire"}
              <InfoBulle align="left">Moyenne des KPI pondérée par leurs poids, chacun noté sur 100 face à sa cible (plafonné à 120). Un KPI sans donnée sort du calcul : son poids se répartit sur les autres.</InfoBulle>
            </p>
            <p className="text-xs text-muted-foreground">
              {bilan.sansDonnee > 0 ? `${bilan.sansDonnee} KPI sans donnée · ` : ""}
              <Badge tone={statut.ton}>{statut.texte}</Badge>
              {bilan.revue.signeeLe && <span> le {formatDate(bilan.revue.signeeLe)}{bilan.revue.signeePar ? ` par ${bilan.revue.signeePar}` : ""}</span>}
            </p>
          </div>
        </div>
        <select
          value={periode} aria-label="Période"
          onChange={(e) => { setPeriode(e.target.value); void recharger(e.target.value); }}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {bilan.periodes.map((p) => <option key={p.cle} value={p.cle}>{p.libelle}</option>)}
          {!bilan.periodes.some((p) => p.cle === bilan.periode.cle) && <option value={bilan.periode.cle}>{bilan.periode.libelle}</option>}
        </select>
      </div>

      {chargement && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Mise à jour…</p>}

      {chiffres.length > 0 && (
        <section className="surface min-w-0 rounded-xl">
          <h3 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Les KPI chiffrés</h3>
          <Table className="min-w-[36rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky left-0 z-10 bg-card">KPI</TableHead>
                <TableHead className="text-right">{bilan.periode.libelle}</TableHead>
                <TableHead className="text-right">Cible</TableHead>
                <TableHead>6 périodes</TableHead>
                <TableHead>D&apos;où vient le chiffre</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chiffres.map((k) => <LigneChiffre key={k.definitionId} k={k} userId={bilan.userId} periode={bilan.periode.cle} />)}
            </TableBody>
          </Table>
        </section>
      )}

      {evalues.map((k) => (
        <CarteEvalue key={k.definitionId} k={k} manager={manager} userId={bilan.userId} periode={bilan.periode.cle} apres={apres} />
      ))}

      {declares.map((k) => (
        <CarteDeclare key={k.definitionId} k={k} manager={manager} soi={bilan.droits.soi && !bilan.figee} periode={bilan.periode.cle} apres={apres} />
      ))}

      {(bilan.revue.commentaireManager || bilan.revue.commentaireLuna || manager) && (
        <Revue bilan={bilan} manager={manager} apres={apres} />
      )}

      {msg && <p className={cn("text-xs", msg.ok ? "text-success" : "text-destructive")}>{msg.texte}</p>}
    </div>
  );
}

function LigneChiffre({ k, userId, periode }: { k: KpiDuBilan; userId: string; periode: string }) {
  const [ouvert, setOuvert] = React.useState(false);
  const [blocs, setBlocs] = React.useState<{ titre: string; lignes: LigneDetail[] }[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const ouvrir = async () => {
    if (ouvert) { setOuvert(false); return; }
    setOuvert(true);
    if (blocs) return;
    setBusy(true);
    const r = await origineKpi(k.definitionId, userId, periode).catch(sansBloquer("bilan-kpi.ouvrir.origineKpi", null));
    setBusy(false);
    setBlocs(r?.ok ? r.blocs : []);
  };
  return (
    <>
      <TableRow>
        <TableCell className="sticky left-0 z-10 max-w-[14rem] bg-card">
          <span className="font-medium">{k.nom}</span>
          <InfoBulle align="left">{k.calcul}{k.definitionBrique ? ` — ${k.definitionBrique}` : ""}</InfoBulle>
          <p className="text-xs text-muted-foreground">{NATURE_LABELS[k.nature]} · poids {k.poids}</p>
        </TableCell>
        <TableCell className="text-right"><PastilleKpi couleur={k.couleur} titre={k.raison ?? undefined}>{k.affichage}</PastilleKpi></TableCell>
        <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">{k.cibleAffichee}</TableCell>
        <TableCell><SparklineKpi notes={k.tendance} /></TableCell>
        <TableCell className="whitespace-nowrap">
          {k.drill ? (
            <button type="button" onClick={() => void ouvrir()} className="text-xs text-primary hover:underline">
              {k.origine ?? "voir le détail"}
            </button>
          ) : <span className="text-xs text-muted-foreground">{k.raison ?? "fichier importé"}</span>}
        </TableCell>
      </TableRow>
      {ouvert && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-secondary/30">
            {busy ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…</p> : (
              <div className="space-y-3">
                {(blocs ?? []).map((b) => (
                  <div key={b.titre} className="space-y-1">
                    <p className="text-xs font-semibold">{b.titre} <span className="font-normal text-muted-foreground">({b.lignes.filter((l) => l.compte).length} / {b.lignes.length})</span></p>
                    {b.lignes.length === 0 ? <p className="text-xs text-muted-foreground">Aucune ligne.</p> : (
                      <ul className="max-h-56 space-y-0.5 overflow-y-auto text-xs">
                        {b.lignes.slice(0, 200).map((l, i) => (
                          <li key={i} className={cn("flex gap-2", !l.compte && "text-muted-foreground")}>
                            <span className="w-16 shrink-0 tabular-nums">{l.date ? formatDate(l.date, { day: "2-digit", month: "2-digit" }) : ""}</span>
                            <span className="min-w-0 flex-1 truncate">{l.libelle}</span>
                            <span className="shrink-0">{l.etat}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type Apres = (r: { ok: boolean; error?: string; message?: string } | null) => Promise<void>;

function CarteEvalue({ k, manager, userId, periode, apres }: { k: KpiDuBilan; manager: boolean; userId: string; periode: string; apres: Apres }) {
  const e = k.evaluation;
  const [choix, setChoix] = React.useState<number | null>(e?.niveau ?? e?.propositionNiveau ?? null);
  const [commentaire, setCommentaire] = React.useState(e?.commentaire ?? "");
  const [busy, setBusy] = React.useState<"luna" | "valider" | null>(null);
  const grille = k.grille ?? [];
  const fd = () => { const f = new FormData(); f.set("definitionId", k.definitionId); f.set("userId", userId); f.set("periode", periode); return f; };
  const luna = async () => { setBusy("luna"); const r = await proposerNiveauKpi(fd()).catch(sansBloquer("bilan-kpi.luna.proposerNiveauKpi", null)); setBusy(null); await apres(r); };
  const valider = async () => {
    if (!choix) return;
    setBusy("valider");
    const f = fd(); f.set("niveau", String(choix)); f.set("commentaire", commentaire);
    const r = await validerEvaluationKpi(f).catch(sansBloquer("bilan-kpi.valider.validerEvaluationKpi", null));
    setBusy(null); await apres(r);
  };
  return (
    <section className="surface min-w-0 rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">{k.nom} <span className="font-normal text-muted-foreground">· évalué · poids {k.poids}</span></h3>
        {e?.niveau ? <Badge tone="success">niveau {e.niveau}/{grille.length}</Badge>
          : e?.propositionNiveau ? <Badge tone="purple">Luna propose {e.propositionNiveau} · à valider</Badge>
            : <Badge tone="neutral">non évalué</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 lg:grid-cols-4">
        {grille.map((n, i) => {
          const niveau = i + 1;
          const sel = choix === niveau;
          return (
            <button
              key={niveau} type="button" disabled={!manager} onClick={() => setChoix(niveau)}
              className={cn("rounded-lg border p-2 text-left text-xs transition-colors", sel ? "border-primary bg-primary/5" : "border-border", manager && "hover:border-primary/60")}
            >
              <b className="block text-sm">{niveau} · {n.libelle}</b>
              {n.critere}
            </button>
          );
        })}
      </div>
      {e && e.preuves.length > 0 && (
        <div className="space-y-1 px-4 pb-3 text-xs text-muted-foreground">
          <p>Preuves retenues par Luna{e.justification ? ` — ${e.justification}` : ""}</p>
          <ul className="space-y-1">
            {e.preuves.map((p, i) => (
              <li key={i}>« {p.extrait} » <span className="whitespace-nowrap">({p.source}{p.date ? ` du ${formatDate(p.date)}` : ""})</span></li>
            ))}
          </ul>
        </div>
      )}
      {manager && (
        <div className="flex flex-col gap-2 border-t border-border p-3 sm:flex-row sm:items-center">
          <input
            value={commentaire} onChange={(ev) => setCommentaire(ev.target.value)} placeholder="Commentaire (facultatif)" aria-label="Commentaire"
            className="min-h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 sm:min-h-0 sm:py-1.5"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void luna()} disabled={busy !== null}>
              {busy === "luna" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Luna
            </Button>
            <Button size="sm" onClick={() => void valider()} disabled={busy !== null || !choix}>
              {busy === "valider" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Valider le niveau
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function CarteDeclare({ k, manager, soi, periode, apres }: { k: KpiDuBilan; manager: boolean; soi: boolean; periode: string; apres: Apres }) {
  const [ouvert, setOuvert] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [motifs, setMotifs] = React.useState<Record<string, string>>({});
  const declarer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    f.set("definitionId", k.definitionId); f.set("periode", periode);
    setBusy(true);
    const r = await declarerKpi(f).catch(sansBloquer("bilan-kpi.declarer.declarerKpi", null));
    setBusy(false);
    if (r?.ok) setOuvert(false);
    await apres(r);
  };
  const decider = async (id: string, decision: "VALIDEE" | "REFUSEE") => {
    const f = new FormData(); f.set("declarationId", id); f.set("decision", decision); f.set("motif", motifs[id] ?? "");
    setBusy(true);
    const r = await deciderDeclarationKpi(f).catch(sansBloquer("bilan-kpi.decider.deciderDeclarationKpi", null));
    setBusy(false); await apres(r);
  };
  return (
    <section className="surface min-w-0 rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">
          {k.nom} <span className="font-normal text-muted-foreground">· déclaré · poids {k.poids} · cible {k.cibleAffichee}</span>
          <InfoBulle align="left">Une déclaration compte une fois validée par le manager, avec sa pièce.</InfoBulle>
        </h3>
        <div className="flex items-center gap-2">
          <PastilleKpi couleur={k.couleur}>{k.affichage}</PastilleKpi>
          {soi && <Button size="sm" variant="outline" onClick={() => setOuvert((v) => !v)}>Déclarer</Button>}
        </div>
      </div>
      {ouvert && (
        <form onSubmit={(e) => void declarer(e)} className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:flex-wrap sm:items-center">
          <input name="libelle" required placeholder="Quoi (« Formation pharmacovigilance, 12/10 »)" aria-label="Libellé" className="min-h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 sm:min-h-0 sm:py-1.5" />
          <input name="valeur" type="number" min={1} step={1} defaultValue={1} aria-label="Valeur" className="min-h-10 w-24 rounded-md border border-input bg-background px-3 py-2 sm:min-h-0 sm:py-1.5" />
          <input name="piece" type="file" required aria-label="Pièce" className="text-xs" />
          <Button type="submit" size="sm" disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Envoyer</Button>
        </form>
      )}
      {k.declarations.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">Aucune déclaration sur la période.</p> : (
        <ul className="divide-y divide-border">
          {k.declarations.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate">{d.libelle} <span className="text-muted-foreground">· {d.valeur}</span></p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(d.le)}
                  {d.piece && <> · <a href={`/api/kpi/piece/${d.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{d.piece}</a></>}
                </p>
              </div>
              {d.statut === "A_VALIDER" && manager ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={motifs[d.id] ?? ""} onChange={(e) => setMotifs((m) => ({ ...m, [d.id]: e.target.value }))} placeholder="Motif (si refus)" aria-label="Motif"
                    className="h-9 w-40 rounded-md border border-input bg-background px-2 text-xs"
                  />
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void decider(d.id, "REFUSEE")}>Refuser</Button>
                  <Button size="sm" disabled={busy} onClick={() => void decider(d.id, "VALIDEE")}>Valider</Button>
                </div>
              ) : (
                <Badge tone={d.statut === "VALIDEE" ? "success" : d.statut === "REFUSEE" ? "danger" : "warning"}>
                  {d.statut === "VALIDEE" ? "validée" : d.statut === "REFUSEE" ? "refusée" : "à valider"}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Revue({ bilan, manager, apres }: { bilan: BilanKpi; manager: boolean; apres: Apres }) {
  const [commentaire, setCommentaire] = React.useState(bilan.revue.commentaireManager ?? "");
  const [luna, setLuna] = React.useState(bilan.revue.commentaireLuna);
  const [busy, setBusy] = React.useState<"luna" | "signer" | null>(null);
  const fd = () => { const f = new FormData(); f.set("userId", bilan.userId); f.set("periode", bilan.periode.cle); return f; };
  const rediger = async () => {
    setBusy("luna");
    const r = await commentaireLunaKpi(fd()).catch(sansBloquer("bilan-kpi.rediger.commentaireLunaKpi", null));
    setBusy(null);
    if (r?.ok && r.texte) { setLuna(r.texte); if (!commentaire.trim()) setCommentaire(r.texte); }
    await apres(r);
  };
  const signer = async () => {
    setBusy("signer");
    const f = fd(); f.set("commentaire", commentaire);
    const r = await signerRevueKpi(f).catch(sansBloquer("bilan-kpi.signer.signerRevueKpi", null));
    setBusy(null); await apres(r);
  };
  return (
    <section className="surface min-w-0 space-y-2 rounded-xl p-4">
      <h3 className="text-sm font-semibold">Revue de {bilan.periode.libelle}</h3>
      {!manager ? (
        <p className="whitespace-pre-line text-sm">{bilan.revue.commentaireManager ?? <span className="text-muted-foreground">Pas encore de commentaire.</span>}</p>
      ) : (
        <>
          <textarea
            value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={4} placeholder="Commentaire du manager" aria-label="Commentaire du manager"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          {luna && luna !== commentaire && (
            <button type="button" onClick={() => setCommentaire(luna)} className="block text-left text-xs text-muted-foreground hover:text-foreground">
              Brouillon de Luna : « {luna.slice(0, 160)}{luna.length > 160 ? "…" : ""} » — reprendre
            </button>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => void rediger()} disabled={busy !== null}>
              {busy === "luna" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Commentaire de Luna
            </Button>
            <BoutonDecisif size="sm" type="button" onClick={() => void signer()} disabled={busy !== null} confirmation="Signer la revue">
              {busy === "signer" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Signer la revue
            </BoutonDecisif>
          </div>
        </>
      )}
    </section>
  );
}
