"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { dinar, pourcent } from "@/lib/budget/marketing-vue";
import {
  FILTRES_DEPENSE, PHRASE_ROUTE, ROUTE_CONSOMMATION, compterParFiltre, libelleEtat, passeLeFiltre,
  type CleFiltreDepense, type EtatDepense, type LieuConsommation,
} from "@/lib/budget/depense-poste";
import {
  annulerDepensePoste, changerBudgetDepensePoste, consommerDepensePoste, imputerDepensePoste,
} from "@/lib/actions/budget-depense-poste-actions";
import type { DonneesDepensesPostes, LigneDepensePoste } from "@/lib/queries/budget-marketing-depenses";

/**
 * BUDGET MARKETING — L'ONGLET « DÉPENSES » (maquette validée par la Direction, 10/2026).
 *
 * Quatre tuiles (budget, engagé, consommé dont payé, disponible), la barre, puis UN tableau des postes Ad & Pro à bon de
 * commande signé — des cartes sous 900 px. Tout geste qui engage le budget (imputer, changer de budget, consommer,
 * annuler) passe par une SECONDE CONFIRMATION qui dit, en une phrase, ce qui va se passer. « Consommer » ouvre un
 * panneau : le montant, la facture facultative, et le chemin que suivra la dépense. Règles : `budget/depense-poste.ts`.
 */

const dzd = (n: number) => `${dinar(n).toLocaleString("fr-FR").replace(/[  ]/g, " ")} DZD`;
const pc = (v: number, base: number) => `${pourcent(v, base).toFixed(1).replace(".", ",")} %`;
/** « 08/10 » — lu sur la chaîne ISO, identique au serveur et au navigateur. */
const jourMois = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const PILL: Record<EtatDepense, string> = {
  A_IMPUTER: "bg-muted text-muted-foreground",
  ENGAGEE: "bg-warning/15 text-warning",
  CONSOMMEE: "bg-primary/10 text-primary",
  PAYEE: "bg-success/10 text-success",
  ANNULEE: "bg-destructive/10 text-destructive",
};
const PILL_LIEU: Partial<Record<LieuConsommation, string>> = {
  CENTRE_PAIEMENT: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  REPONSE_DEMANDEE: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  REFUSEE: "bg-destructive/10 text-destructive",
};

interface Confirmation {
  titre: string;
  corps: string;
  bouton: string;
  danger?: boolean;
  motif?: boolean;
  ok: (motif: string) => Promise<void>;
}

// Le tableau devient des cartes sous 900 px : chaque cellule porte son libellé (`data-l`) au-dessus de sa valeur.
// Au-dessus, une ligne verticale sépare CHAQUE colonne, plus marquée (2 px) avant les colonnes de gestes.
const TD = "min-w-0 px-3 py-2.5 align-top max-[900px]:block max-[900px]:w-full max-[900px]:p-0 max-[900px]:before:mb-1 max-[900px]:before:block max-[900px]:before:text-[11px] max-[900px]:before:font-semibold max-[900px]:before:uppercase max-[900px]:before:tracking-wide max-[900px]:before:text-muted-foreground max-[900px]:before:content-[attr(data-l)]";
const SEP = "min-[900px]:border-l min-[900px]:border-border";
const SPLIT = "min-[900px]:border-l-2 min-[900px]:border-border";
const TH = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

export function DepensesMarketing({ donnees, annee, enveloppe }: { donnees: DonneesDepensesPostes; annee: string; enveloppe: string }) {
  const router = useRouter();
  const { lignes, options, tuiles: t, peutGerer } = donnees;
  const [filtre, setFiltre] = React.useState<CleFiltreDepense>("TOUT");
  const [edition, setEdition] = React.useState<string | null>(null);
  const [choix, setChoix] = React.useState<Record<string, string>>({});
  const [panneau, setPanneau] = React.useState<LigneDepensePoste | null>(null);
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [occupe, setOccupe] = React.useState(false);

  React.useEffect(() => {
    if (!message) return;
    const h = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(h);
  }, [message]);

  const nomOption = (id: string | null | undefined) => options.find((o) => o.id === id)?.label ?? null;
  const choixDe = (l: LigneDepensePoste) => choix[l.id] ?? (l.categorieId && options.some((o) => o.id === l.categorieId) ? l.categorieId : options[0]?.id ?? "");
  const comptes = compterParFiltre(lignes.map((l) => l.etat));
  const visibles = lignes.filter((l) => passeLeFiltre(l.etat, filtre));

  const agir = async (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, apres?: () => void) => {
    setOccupe(true);
    try {
      const r = await fn();
      if (r.ok) {
        apres?.();
        setMessage(r.message ?? "Enregistré.");
        router.refresh();
      } else setMessage(r.error ?? "L'action n'a pas abouti.");
    } finally {
      setOccupe(false);
    }
  };

  const demanderImputation = (l: LigneDepensePoste) => {
    const cible = choixDe(l);
    if (!cible) return;
    const premiere = l.etat === "A_IMPUTER";
    if (!premiere && cible === l.categorieId) { setEdition(null); return; }
    const nom = nomOption(cible) ?? "ce budget";
    setConfirmation({
      titre: premiere ? "Imputer cette dépense ?" : "Changer de budget ?",
      corps: premiere
        ? `${dzd(l.montantEngage)} seront engagés sur « ${nom} ».`
        : `${dzd(l.consomme > 0 ? l.consomme : l.montantEngage)} passent de « ${l.categorie ?? "—"} » à « ${nom} ». Le changement est tracé au journal.`,
      bouton: premiere ? "Imputer" : "Changer de budget",
      ok: async () => {
        const fd = new FormData();
        fd.set("id", l.id);
        fd.set("categorieId", cible);
        await agir(() => (premiere ? imputerDepensePoste(fd) : changerBudgetDepensePoste(fd)), () => setEdition(null));
      },
    });
  };

  const demanderAnnulation = (l: LigneDepensePoste) => setConfirmation({
    titre: "Annuler cette dépense ?",
    danger: true,
    motif: true,
    corps: `L'engagement de ${dzd(l.montantEngage)} sur « ${l.categorie ?? "—"} » est libéré.${l.bcs.length ? ` ${l.bcs.length > 1 ? "Les bons de commande" : "Le bon de commande"} ${l.bcs.map((b) => b.reference).join(", ")} ${l.bcs.length > 1 ? "restent" : "reste"} au registre.` : ""}`,
    bouton: "Annuler la dépense",
    ok: async (motif) => {
      const fd = new FormData();
      fd.set("id", l.id);
      if (motif) fd.set("motif", motif);
      await agir(() => annulerDepensePoste(fd));
    },
  });

  return (
    <div className="grid min-w-0 gap-4">
      {/* ── Les quatre tuiles ─────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3 min-[900px]:grid-cols-4" aria-label="Chiffres de l'enveloppe">
        <Tuile k={`Budget ${annee}`} v={dzd(t.budget)} c={enveloppe} />
        <Tuile k="Engagé" pastille="bg-warning" v={dzd(t.engage)} c={`${pc(t.engage, t.budget)} · BC signés, pas encore consommés`} />
        <Tuile k="Consommé" pastille="bg-primary" v={dzd(t.consomme)} c={`${pc(t.consomme, t.budget)} · dont ${dzd(t.paye)} payés`} />
        <Tuile k="Disponible" pastille="bg-success" v={dzd(t.disponible)} c="Budget − engagé − consommé" alerte={t.disponible < 0} />
      </section>

      <section className="surface min-w-0 rounded-xl px-4 py-3.5" aria-label="Répartition de l'enveloppe">
        <div className="flex h-3 overflow-hidden rounded-full border border-border bg-muted" role="img" aria-label={`Consommé ${pc(t.consomme, t.budget)}, engagé ${pc(t.engage, t.budget)}, disponible ${pc(Math.max(0, t.disponible), t.budget)}`}>
          <span className="h-full bg-primary motion-safe:transition-[width]" style={{ width: `${Math.min(100, pourcent(t.consomme, t.budget))}%` }} />
          <span className="h-full bg-warning motion-safe:transition-[width]" style={{ width: `${Math.min(Math.max(0, 100 - pourcent(t.consomme, t.budget)), pourcent(t.engage, t.budget))}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-primary" />Consommé <b className="font-semibold tabular-nums text-foreground">{dzd(t.consomme)}</b></span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-warning" />Engagé <b className="font-semibold tabular-nums text-foreground">{dzd(t.engage)}</b></span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px] border border-border bg-muted" />Disponible <b className={cn("font-semibold tabular-nums text-foreground", t.disponible < 0 && "text-destructive")}>{dzd(t.disponible)}</b></span>
          <span>· dont payé par les Finances <b className="font-semibold tabular-nums text-foreground">{dzd(t.paye)}</b></span>
        </div>
      </section>

      {/* ── Le tableau des dépenses ────────────────────────────── */}
      <section className="surface min-w-0 rounded-xl" aria-label="Les dépenses">
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Postes Ad &amp; Pro à bon de commande signé</h2>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer par état">
            {FILTRES_DEPENSE.map((f) => (
              <button
                key={f.cle} type="button" aria-pressed={filtre === f.cle} onClick={() => setFiltre(f.cle)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium focus-ring",
                  filtre === f.cle ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:bg-secondary",
                )}
              >
                {f.libelle}<span className="ml-1 tabular-nums text-muted-foreground">{comptes[f.cle]}</span>
              </button>
            ))}
          </div>
        </div>
        <table className="w-full table-fixed border-collapse text-sm max-[900px]:block">
          <colgroup className="max-[900px]:hidden">
            <col className="w-[20%]" /><col className="w-[23%]" /><col className="w-[11%]" /><col className="w-[19%]" /><col className="w-[13%]" /><col className="w-[14%]" />
          </colgroup>
          <thead className="bg-muted/60 max-[900px]:hidden">
            <tr className="border-b border-border">
              <th className={TH}>Poste · demande</th>
              <th className={cn(TH, SEP)}>Bons de commande</th>
              <th className={cn(TH, SEP, "text-right")}>Montant</th>
              <th className={cn(TH, SPLIT)}>Imputation au budget</th>
              <th className={cn(TH, SPLIT)}>Action</th>
              <th className={cn(TH, SEP)}>État</th>
            </tr>
          </thead>
          <tbody className="max-[900px]:block">
            {visibles.length === 0 ? (
              <tr className="max-[900px]:block"><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground max-[900px]:block">{lignes.length === 0 ? "Aucun poste Ad & Pro à bon de commande signé pour cette enveloppe." : "Aucune dépense dans cet état."}</td></tr>
            ) : visibles.map((l) => (
              <tr key={l.id} className="border-b border-border last:border-b-0 max-[900px]:grid max-[900px]:w-full max-[900px]:gap-2.5 max-[900px]:px-4 max-[900px]:py-3">
                <td data-l="Poste · demande" className={cn(TD, l.etat === "ANNULEE" && "opacity-60")}>
                  <Lien href={l.posteHref} className="font-semibold">{l.poste}</Lien>
                  <div className="mt-0.5 text-xs">
                    <Lien href={l.demandeHref} className="text-muted-foreground hover:text-primary">{l.demande}</Lien>
                    {l.typeDemande && <span className="text-muted-foreground"> · {l.typeDemande}</span>}
                  </div>
                </td>
                <td data-l="Bons de commande" className={cn(TD, SEP, l.etat === "ANNULEE" && "opacity-60")}>
                  {l.bcs.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : (
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {l.bcs.map((b) => <PuceBc key={b.id} bc={b} />)}
                    </div>
                  )}
                </td>
                <td data-l="Montant" className={cn(TD, SEP, "text-right tabular-nums max-[900px]:text-left", l.etat === "ANNULEE" && "opacity-60")}>
                  <span className="[overflow-wrap:anywhere]">{dzd(l.montantEngage)}</span>
                  {l.bcs.length > 1 && <div className="text-xs text-muted-foreground">{l.bcs.length} BC</div>}
                </td>
                <td data-l="Imputation au budget" className={cn(TD, SPLIT)}>
                  <CelluleImputation
                    l={l} peutGerer={peutGerer} options={options} enEdition={edition === l.id} valeur={choixDe(l)} occupe={occupe}
                    onChoix={(v) => setChoix((c) => ({ ...c, [l.id]: v }))}
                    onValider={() => demanderImputation(l)}
                    onEditer={() => { setEdition(l.id); setChoix((c) => ({ ...c, [l.id]: l.categorieId ?? "" })); }}
                    onRetour={() => setEdition(null)}
                  />
                </td>
                <td data-l="Action" className={cn(TD, SPLIT)}>
                  <CelluleAction l={l} peutGerer={peutGerer} occupe={occupe} onConsommer={() => setPanneau(l)} onAnnuler={() => demanderAnnulation(l)} />
                </td>
                <td data-l="État" className={cn(TD, SEP)}>
                  <span className={cn("inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-semibold leading-tight", PILL[l.etat], l.lieu && PILL_LIEU[l.lieu])}>
                    {libelleEtat(l.etat, l.lieu)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-3" aria-label="Les règles de l'écran">
        <Regle titre="Engagé = BC signés + imputation">Un poste n&apos;entre au budget qu&apos;une fois ses bons de commande signés et son imputation faite par la Direction Marketing. Le montant est la somme de ses BC.</Regle>
        <Regle titre="L'imputation se change à tout moment">Engagée, consommée ou payée, une dépense peut être rangée dans un autre budget. Le changement est confirmé, puis tracé au journal.</Regle>
        <Regle titre="Consommer ou annuler, toujours confirmé">« Consommer » envoie la dépense au centre de paiement, où la Direction Générale l&apos;autorise, puis aux Finances qui la règlent. « Annuler » libère l&apos;engagement. Les deux passent par une seconde confirmation.</Regle>
      </section>

      <PanneauConsommer
        ligne={panneau} occupe={occupe}
        onFermer={() => setPanneau(null)}
        onConfirmer={(montant, fichier) => {
          const l = panneau;
          if (!l) return;
          const rendu = l.montantEngage - montant;
          setConfirmation({
            titre: "Confirmer la consommation ?",
            corps: `${dzd(montant)} passent d'engagé à consommé sur « ${l.categorie ?? "—"} »${rendu > 0.5 ? `, ${dzd(rendu)} sont rendus au budget` : ""}. La dépense part au centre de paiement (Direction Générale), puis aux Finances${fichier ? `, avec la facture ${fichier.name}` : ", sans facture pour l'instant"}.`,
            bouton: "Consommer",
            ok: async () => {
              const fd = new FormData();
              fd.set("id", l.id);
              fd.set("montant", String(montant));
              if (fichier) fd.set("facture", fichier);
              await agir(() => consommerDepensePoste(fd), () => setPanneau(null));
            },
          });
        }}
      />

      {confirmation && <FenetreConfirmation c={confirmation} occupe={occupe} onFermer={() => setConfirmation(null)} />}

      {message && (
        <div role="status" className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 z-[70] max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-lg">
          {message}
        </div>
      )}
    </div>
  );
}

function Tuile({ k, v, c, pastille, alerte }: { k: string; v: string; c: string; pastille?: string; alerte?: boolean }) {
  return (
    <div className="surface grid min-w-0 gap-1 rounded-xl px-4 py-3.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {pastille && <i className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]", pastille)} />}{k}
      </span>
      <span className={cn("text-xl font-bold tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-[22px]", alerte && "text-destructive")}>{v}</span>
      <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{c}</span>
    </div>
  );
}

function Regle({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <div className="surface grid gap-1.5 rounded-xl p-3.5 text-[13px]">
      <h3 className="text-[13px] font-semibold">{titre}</h3>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}

/** Un lien de l'ERP, ou un texte quand la personne n'a pas accès à la fiche. */
function Lien({ href, className, children }: { href: string | null; className?: string; children: React.ReactNode }) {
  if (!href) return <span className={cn("[overflow-wrap:anywhere]", className)}>{children}</span>;
  return <Link href={href} className={cn("rounded text-primary [overflow-wrap:anywhere] hover:underline focus-ring", className)}>{children}</Link>;
}

function PuceBc({ bc }: { bc: LigneDepensePoste["bcs"][number] }) {
  const contenu = (
    <>
      <span className="whitespace-nowrap text-xs font-semibold tabular-nums text-primary">{bc.reference}</span>
      {bc.fournisseur && <span className="max-w-[15rem] truncate text-[11px] text-muted-foreground">{bc.fournisseur}</span>}
      <span className="text-[11px] tabular-nums">{bc.montant != null ? dzd(bc.montant) : "Montant non lu"}{bc.signeLe ? ` · signé ${jourMois(bc.signeLe)}` : " · non signé"}</span>
    </>
  );
  const classe = "grid min-w-0 max-w-full gap-px rounded-lg border border-border bg-card px-2.5 py-1.5 text-left";
  if (!bc.href) return <span className={classe} title={bc.fournisseur ?? undefined}>{contenu}</span>;
  return (
    <Link href={bc.href} title={bc.fournisseur ? `${bc.reference} — ${bc.fournisseur}` : bc.reference} className={cn(classe, "hover:border-primary hover:bg-primary/5 focus-ring")}>
      {contenu}
    </Link>
  );
}

function CelluleImputation({ l, peutGerer, options, enEdition, valeur, occupe, onChoix, onValider, onEditer, onRetour }: {
  l: LigneDepensePoste; peutGerer: boolean; options: { id: string; label: string }[]; enEdition: boolean; valeur: string; occupe: boolean;
  onChoix: (v: string) => void; onValider: () => void; onEditer: () => void; onRetour: () => void;
}) {
  if (l.etat === "ANNULEE") return <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{l.categorie ?? "—"} — engagement libéré</span>;
  if (l.etat === "A_IMPUTER" || enEdition) {
    if (!peutGerer || options.length === 0) {
      return <span className="text-xs text-muted-foreground">{peutGerer ? "Aucune catégorie dans l'enveloppe : créez-en une dans les Réglages." : "À imputer par la Direction Marketing."}</span>;
    }
    const nom = options.find((o) => o.id === valeur)?.label ?? "";
    // Le menu ne prend JAMAIS la largeur de sa plus longue option : il occupe sa colonne, et le libellé se tronque.
    return (
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
        <select
          value={valeur} onChange={(e) => onChoix(e.target.value)} title={nom} aria-label={`Budget pour ${l.poste}`}
          className="block w-full min-w-0 max-w-full truncate rounded-lg border border-border bg-card px-2 py-1.5 text-[13px] focus-ring"
        >
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onValider} disabled={occupe || !valeur}>{l.etat === "A_IMPUTER" ? "Imputer" : "Enregistrer"}</Button>
          {enEdition && <Button size="sm" variant="ghost" onClick={onRetour}>Retour</Button>}
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-1">
      <span className="[overflow-wrap:anywhere]">{l.categorie ?? "—"}</span>
      {peutGerer && (
        <button type="button" onClick={onEditer} className="justify-self-start rounded text-left text-xs text-muted-foreground hover:text-primary hover:underline focus-ring">
          Changer de budget
        </button>
      )}
    </div>
  );
}

function CelluleAction({ l, peutGerer, occupe, onConsommer, onAnnuler }: {
  l: LigneDepensePoste; peutGerer: boolean; occupe: boolean; onConsommer: () => void; onAnnuler: () => void;
}) {
  if (l.etat === "A_IMPUTER") return <span className="text-xs text-muted-foreground">Après imputation</span>;
  if (l.etat === "ENGAGEE") {
    if (!peutGerer) return <span className="text-xs text-muted-foreground">Engagée, à consommer</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={onConsommer} disabled={occupe}>Consommer</Button>
        <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" onClick={onAnnuler} disabled={occupe}>Annuler</Button>
      </div>
    );
  }
  if (l.etat === "ANNULEE") return <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{l.motif ?? "Sans motif"}</span>;
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="tabular-nums [overflow-wrap:anywhere]">{dzd(l.consomme)}</span>
      {l.facture ? (
        <Lien href={l.facture.href} className="inline-flex items-center gap-1 text-xs font-normal">
          <Paperclip className="h-3 w-3 shrink-0" aria-hidden />{l.facture.nom}
        </Lien>
      ) : <span className="text-xs text-muted-foreground">{l.etat === "PAYEE" ? "Sans facture au poste" : "Facture à joindre"}</span>}
      {l.ordre && <span className="text-[11px] text-muted-foreground">{l.ordre}</span>}
    </div>
  );
}

function PanneauConsommer({ ligne, occupe, onFermer, onConfirmer }: {
  ligne: LigneDepensePoste | null; occupe: boolean; onFermer: () => void; onConfirmer: (montant: number, fichier: File | null) => void;
}) {
  const [montant, setMontant] = React.useState("");
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const champ = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!ligne) return;
    setMontant(String(Math.round(ligne.montantEngage * 100) / 100));
    setFichier(null);
    setErreur(null);
    const h = setTimeout(() => champ.current?.focus(), 50);
    return () => clearTimeout(h);
  }, [ligne]);
  if (!ligne) return null;
  const valider = () => {
    const m = Number(montant.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(m) || m <= 0) { setErreur("Indiquez le montant consommé."); return; }
    if (m > ligne.montantEngage + 0.005) { setErreur(`Le montant consommé ne dépasse pas l'engagé (${dzd(ligne.montantEngage)}).`); return; }
    setErreur(null);
    onConfirmer(m, fichier);
  };
  return (
    <Sheet
      open title="Consommer la dépense" description={`${ligne.poste} · ${ligne.demande}`} onClose={onFermer}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onFermer}>Fermer</Button>
          <Button onClick={valider} disabled={occupe}>Consommer…</Button>
        </div>
      )}
    >
      <div className="grid content-start gap-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Bons de commande</dt><dd className="text-right [overflow-wrap:anywhere]">{ligne.bcs.map((b) => b.reference).join(", ") || "—"}</dd>
          <dt className="text-muted-foreground">Imputé sur</dt><dd className="text-right [overflow-wrap:anywhere]">{ligne.categorie ?? "—"}</dd>
          <dt className="text-muted-foreground">Engagé</dt><dd className="text-right tabular-nums">{dzd(ligne.montantEngage)}</dd>
        </dl>
        <div className="grid gap-1.5">
          <label htmlFor="conso-montant" className="text-xs font-semibold">Montant consommé (DZD)</label>
          <input
            ref={champ} id="conso-montant" type="number" min={0} max={ligne.montantEngage} step="0.01" inputMode="decimal"
            value={montant} onChange={(e) => setMontant(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] tabular-nums focus-ring"
          />
          <span className="text-xs text-muted-foreground">Par défaut, le montant engagé. Un montant inférieur rend la différence au budget.</span>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-semibold">Facture <span className="font-normal text-muted-foreground">(facultative)</span></span>
          <label
            htmlFor="conso-facture"
            className="cursor-pointer rounded-lg border-[1.5px] border-dashed border-border bg-muted/50 p-3.5 text-center text-[13px] text-muted-foreground [overflow-wrap:anywhere] hover:border-primary focus-within:outline focus-within:outline-2 focus-within:outline-primary"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setFichier(f); }}
          >
            {fichier ? <span className="inline-flex items-center gap-1.5 text-foreground"><Paperclip className="h-3.5 w-3.5" aria-hidden />{fichier.name}</span> : "Déposer la facture, ou cliquer pour la choisir"}
            <input id="conso-facture" type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} />
          </label>
          {!fichier && <span className="text-xs text-muted-foreground">Sans facture, les Finances la demanderont avant de régler : elle se joint plus tard au dossier de paiement.</span>}
        </div>
        <div className="grid gap-2 rounded-lg border border-border bg-muted/50 p-3">
          <span className="text-xs font-semibold">Après confirmation, la dépense part :</span>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {ROUTE_CONSOMMATION.map((e, i) => (
              <React.Fragment key={e}>
                {i > 0 && <span className="text-muted-foreground" aria-hidden>→</span>}
                <span className={cn("rounded-full border bg-card px-2.5 py-1 font-semibold", i === 1 ? "border-primary text-primary" : "border-border")}>{e}</span>
              </React.Fragment>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">{PHRASE_ROUTE}</span>
        </div>
        {erreur && <p className="text-sm text-destructive" role="alert">{erreur}</p>}
      </div>
    </Sheet>
  );
}

function FenetreConfirmation({ c, occupe, onFermer }: { c: Confirmation; occupe: boolean; onFermer: () => void }) {
  const [motif, setMotif] = React.useState("");
  const bouton = React.useRef<HTMLButtonElement>(null);
  const fermer = React.useRef(onFermer);
  fermer.current = onFermer;
  React.useEffect(() => {
    bouton.current?.focus();
    // Échap ferme la fenêtre — et elle seule : capturé avant le panneau qui est dessous.
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fermer.current(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  const confirmer = async () => {
    const m = motif.trim();
    onFermer();
    await c.ok(m);
  };
  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/40" onClick={onFermer} />
      <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
        <div role="alertdialog" aria-modal="true" aria-labelledby="conf-titre" aria-describedby="conf-corps" className="pointer-events-auto relative grid w-full max-w-[440px] gap-3.5 rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <h3 id="conf-titre" className="text-base font-semibold">{c.titre}</h3>
          <p id="conf-corps" className="text-sm">{c.corps}</p>
          {c.motif && (
            <div className="grid gap-1.5">
              <label htmlFor="conf-motif" className="text-xs font-semibold">Motif <span className="font-normal text-muted-foreground">(facultatif)</span></label>
              <textarea id="conf-motif" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Ex. événement reporté à l'an prochain" maxLength={500} className="min-h-[70px] w-full resize-y rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] focus-ring" />
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onFermer}>Retour</Button>
            <Button ref={bouton} variant={c.danger ? "destructive" : "primary"} onClick={() => void confirmer()} disabled={occupe}>{c.bouton}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
