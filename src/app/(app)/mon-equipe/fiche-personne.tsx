"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ClipboardList, Loader2, MessageSquare } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { cn, formatDate } from "@/lib/utils";
import type { LigneEquipe } from "@/lib/queries/my-team-overview";
import type { TeamMemberKpis } from "@/lib/queries/team-kpis";
import type { TeamKpi } from "@/lib/hr/team-kpis";
import { teamMemberKpis } from "@/lib/actions/my-team-actions";
import { createDirect } from "@/lib/actions/messaging-actions";
import { createTask } from "@/lib/actions/task-actions";
import { lienRapportsDeDelegue } from "@/lib/chemins/rapports-terrain";
import { Avatar, jourCourt, jourLong, statutDuJour } from "./equipe-commun";
import { sansBloquer } from "@/lib/journal";

/**
 * LE PANNEAU D'UNE PERSONNE — ouvert d'un clic sur son nom, n'importe où dans Mon Équipe. Ce qui est déjà calculé pour
 * le tableau s'affiche tout de suite ; les indicateurs du métier (dossiers, déclarations, courses, portefeuille…) se
 * chargent à l'ouverture par l'action existante, gardée par la hiérarchie (`teamMemberKpis`).
 */
export function FichePersonne({ ligne, droits, onClose }: {
  ligne: LigneEquipe | null;
  droits: { messagerie: boolean; taches: boolean; rapports: boolean };
  onClose: () => void;
}) {
  return (
    <Sheet open={ligne !== null} onClose={onClose} title={ligne?.nom ?? ""} width="md">
      {ligne && <Contenu key={ligne.employeeId} l={ligne} droits={droits} />}
    </Sheet>
  );
}

function Contenu({ l, droits }: { l: LigneEquipe; droits: { messagerie: boolean; taches: boolean; rapports: boolean } }) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [kpis, setKpis] = React.useState<TeamMemberKpis | null>(null);
  const [chargement, setChargement] = React.useState(true);
  const [ecrireBusy, setEcrireBusy] = React.useState(false);
  const [tacheOuverte, setTacheOuverte] = React.useState(false);
  const [titre, setTitre] = React.useState("");
  const [echeance, setEcheance] = React.useState("");
  const [tacheBusy, setTacheBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; texte: string } | null>(null);

  React.useEffect(() => {
    let vivant = true;
    teamMemberKpis(l.employeeId)
      .then((r) => { if (vivant && r.ok) setKpis(r.kpis); })
      .catch(sansBloquer("fiche-personne.Contenu.teamMemberKpis", null))
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [l.employeeId]);

  const ecrire = async () => {
    if (!l.userId) return;
    setEcrireBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("userId", l.userId);
    const r = await createDirect(fd).catch(sansBloquer("fiche-personne.ecrire.createDirect", null));
    setEcrireBusy(false);
    if (r?.ok && r.id) router.push(`/messages?c=${r.id}`);
    else setMsg({ ok: false, texte: r?.error ?? "La conversation n'a pas pu s'ouvrir." });
  };

  const assigner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!l.userId || !titre.trim()) return;
    setTacheBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("title", titre.trim());
    fd.set("assignedToId", l.userId);
    if (echeance) fd.set("dueDate", echeance);
    const r = await createTask(undefined, fd).catch(sansBloquer("fiche-personne.assigner.createTask", null));
    setTacheBusy(false);
    if (r?.ok) {
      setMsg({ ok: true, texte: r.message ?? "Tâche envoyée — elle attend son acceptation." });
      setTitre(""); setEcheance(""); setTacheOuverte(false);
      rafraichir();
    } else setMsg({ ok: false, texte: r?.error ?? "La tâche n'a pas pu être créée." });
  };

  const statut = statutDuJour(l);
  const liens = [...(kpis?.common ?? []), ...(kpis?.job_ ?? [])].filter((k): k is TeamKpi & { href: string } => Boolean(k.href));
  const t = l.terrainMois;

  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-center gap-3">
        <Avatar nom={l.nom} absent={l.aujourdhui.genre !== "PRESENT"} taille="lg" />
        <div className="min-w-0">
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {[l.poste, l.rattachement, l.depuis ? `depuis ${formatDate(l.depuis, { month: "short", year: "numeric" })}` : null].filter(Boolean).join(" · ") || "—"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={statut.tone}>{statut.texte}</Badge>
            {!l.direct && l.nPlus1 && <span className="text-xs text-muted-foreground">via {l.nPlus1}</span>}
          </div>
        </div>
      </div>

      <Bloc titre="Ce mois">
        {t ? (
          <Chiffres items={[
            { label: "Visites", valeur: `${t.faites}/${t.prevues}` },
            { label: "Couverture", valeur: t.couverture !== null ? `${t.couverture} %` : "—" },
            { label: "Sans rapport", valeur: String(t.sansRapport), ton: t.sansRapport > 0 ? "warning" : undefined },
          ]} />
        ) : (
          <Chiffres items={[
            { label: "Tâches ouvertes", valeur: l.userId ? String(l.taches.ouvertes) : "—" },
            { label: "En retard", valeur: l.userId ? String(l.taches.enRetard) : "—", ton: l.taches.enRetard > 0 ? "danger" : undefined },
            { label: "Terminées (30 j)", valeur: l.activite?.type === "TACHES" ? String(l.activite.faites) : "—" },
          ]} />
        )}
      </Bloc>

      <Bloc titre="Congés">
        <Chiffres items={[
          { label: "Solde", valeur: `${l.solde} j`, ton: l.solde > 30 ? "warning" : undefined },
          { label: "Pris cette année", valeur: `${l.prisAnnee} j` },
          { label: "Prochain", valeur: l.prochainConge ? jourCourt(l.prochainConge.debut) : "—" },
        ]} />
      </Bloc>

      <Bloc titre="En cours">
        <ul className="space-y-1.5">
          {l.userId && (
            <li>{l.taches.ouvertes} tâche(s) ouverte(s){l.taches.enRetard > 0 && <span className="text-destructive"> — {l.taches.enRetard} en retard</span>}</li>
          )}
          {l.aDecider > 0 && <li className="text-warning">{l.aDecider} demande(s) à décider</li>}
          {l.enCours.plansEnAttente > 0 && <li>{l.enCours.plansEnAttente} plan(s) de tournée en attente de validation</li>}
          {l.enCours.ordresMission > 0 && <li>{l.enCours.ordresMission} ordre(s) de mission demandé(s)</li>}
          {l.enCours.formations.map((f) => <li key={`${f.titre}-${f.debut}`}>Formation « {f.titre} » — {jourCourt(f.debut)}</li>)}
          {l.alertes.map((a) => (
            <li key={a.genre} className={cn(a.ton === "danger" && "text-destructive", a.ton === "warning" && "text-warning")}>{a.texte}</li>
          ))}
          {!l.userId && l.aDecider === 0 && l.alertes.length === 0 && <li className="text-muted-foreground">Rien en cours.</li>}
        </ul>
      </Bloc>

      <Bloc titre="Contrat">
        <p>
          {l.contrat.type ?? "Type non renseigné"}
          {l.contrat.debut && <span className="text-muted-foreground"> · depuis le {jourLong(l.contrat.debut)}</span>}
          {l.contrat.fin && <span className="text-muted-foreground"> · jusqu&apos;au {jourLong(l.contrat.fin)}</span>}
        </p>
        {l.contrat.finEssai && <p className="text-xs text-muted-foreground">Période d&apos;essai jusqu&apos;au {jourLong(l.contrat.finEssai)}</p>}
      </Bloc>

      {(chargement || (kpis && kpis.job_.length > 0)) && (
        <Bloc titre={kpis?.jobLabel ?? "Indicateurs du métier"}>
          {chargement ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…</p>
          ) : kpis && (
            <Chiffres items={kpis.job_.map((k) => ({ label: k.label, valeur: String(k.value), ton: k.tone === "danger" ? "danger" : k.tone === "warning" ? "warning" : undefined }))} />
          )}
        </Bloc>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {droits.messagerie && l.userId && (
          <Button size="sm" onClick={() => void ecrire()} disabled={ecrireBusy}>
            {ecrireBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />} Écrire
          </Button>
        )}
        {droits.taches && l.userId && (
          <Button size="sm" variant="outline" onClick={() => setTacheOuverte((v) => !v)}>
            <ClipboardList className="h-3.5 w-3.5" /> Assigner une tâche
          </Button>
        )}
        {/* Le terrain : ses rapports, la liste des Rapports filtrée sur lui (`?delegue=`). */}
        {droits.rapports && l.userId && l.terrainMois && (
          <Link href={lienRapportsDeDelegue(l.userId)} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary">
            Voir ses rapports <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}
        {liens.map((k) => (
          <Link key={k.cle} href={k.href} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary">
            {k.label} <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        ))}
      </div>

      {tacheOuverte && (
        <form onSubmit={(e) => void assigner(e)} className="space-y-2 rounded-lg border border-border p-3">
          <input
            value={titre} onChange={(e) => setTitre(e.target.value)} placeholder="Intitulé de la tâche" aria-label="Intitulé de la tâche" required
            className="min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 sm:min-h-0 sm:py-1.5"
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} aria-label="Échéance"
              className="min-h-10 rounded-md border border-input bg-background px-3 py-2 sm:min-h-0 sm:flex-1 sm:py-1.5"
            />
            <Button type="submit" size="sm" disabled={tacheBusy || !titre.trim()}>
              {tacheBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Envoyer
            </Button>
          </div>
        </form>
      )}
      {msg && <p className={cn("text-xs", msg.ok ? "text-success" : "text-destructive")}>{msg.texte}</p>}
    </div>
  );
}

function Bloc({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{titre}</h3>
      {children}
    </section>
  );
}

function Chiffres({ items }: { items: { label: string; valeur: string; ton?: "warning" | "danger" }[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0 rounded-lg bg-secondary/40 px-2.5 py-2">
          <p className={cn("text-base font-semibold tabular-nums", i.ton === "warning" && "text-warning", i.ton === "danger" && "text-destructive")}>{i.valeur}</p>
          <p className="truncate text-xs text-muted-foreground">{i.label}</p>
        </div>
      ))}
    </div>
  );
}
