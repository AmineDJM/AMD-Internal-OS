"use client";

import * as React from "react";
import { Loader2, Check, Undo2, Paperclip } from "lucide-react";
import { markSalaryPaid, unmarkSalaryPaid, updatePayrollEntry } from "@/lib/actions/payroll-hr-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn, formatBytes, formatCurrency, formatMontant, formatMonth, initials } from "@/lib/utils";
import { DocumentPreview } from "@/components/documents/document-preview";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { FILTRE_SANS_ENTITE, masseDuFiltre, type ColonneMasse } from "./masse-mensuelle";

export interface PayrollCell {
  /**
   * Où en est le salaire (§118.176) : `UNPAID` rien de saisi ; `SAISI` saisi, pas encore envoyé ;
   * `ENVOYE` dans la paie de l'entité partie au centre de paiement ; `VIRE` réglé par les Finances
   * (ou transféré par l'ancien circuit). « Payé » avant le virement aurait été une promesse.
   */
  state: "UNPAID" | "SAISI" | "ENVOYE" | "VIRE";
  /** Brut — ligne de bulletin. */
  amount: number | null;
  /** Net = ce que perçoit le salarié. */
  net: number | null;
  /** Coût employeur réellement enregistré — c'est lui qu'on rouvre pour corriger. */
  employerCost?: number | null;
  entryId: string | null;
  /**
   * LA FICHE DE PAIE ATTACHÉE À CE MOIS, quand elle a été déposée — rouvrable d'ici (un clic sur
   * le montant), car un fichier qu'on ne peut pas revoir depuis l'endroit où on l'a déposé est perdu.
   */
  payslip: { id: string; name: string; sizeBytes: number | null; addedAt: string } | null;
}
export interface PayrollRow {
  employeeId: string;
  name: string;
  /** Poste de la fiche salarié — sous le nom, dans la colonne collante. */
  poste: string | null;
  /** Entité de la fiche salarié — ce que filtre le sélecteur d'entité. */
  companyId: string | null;
  /** Pré-remplissage au marquage : salaire brut (→ budget) et net (→ salarié). */
  defaultGross: number | null;
  /** Coût employeur de référence — ce qui préremplit le champ obligatoire de la paie. */
  defaultEmployerCost: number | null;
  defaultNet: number | null;
  months: PayrollCell[]; // index 0 = janvier
}

const MONTHS = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** Le POINT d'état d'une case (maquette « Paie ») : gris saisi, orange envoyé au centre, vert viré. */
const ETAT_CELLULE: Record<Exclude<PayrollCell["state"], "UNPAID">, { texte: string; point: string; titre: string }> = {
  SAISI: { texte: "Saisi", point: "bg-muted-foreground/60", titre: "saisi — part avec la paie de son entité (annulable tant qu'elle n'est pas envoyée)" },
  ENVOYE: { texte: "Envoyé au centre", point: "bg-warning", titre: "dans la paie envoyée au centre de paiement" },
  VIRE: { texte: "Viré", point: "bg-success", titre: "viré par les Finances" },
};

/** Colonne collante : fond opaque, filet droit en ombre (une bordure de table fusionnée ne suit pas le collage). */
const COLLEE = "sticky left-0 z-10 bg-card shadow-[1px_0_0_hsl(var(--border)),4px_0_6px_-4px_rgb(0_0_0/0.12)]";
/** La teinte d'en-tête / de pied, peinte par une ombre intérieure sur le fond opaque de la colonne collante. */
const TEINTE = "shadow-[inset_0_0_0_9999px_hsl(var(--muted)/0.4),1px_0_0_hsl(var(--border)),4px_0_6px_-4px_rgb(0_0_0/0.12)]";

type Mode = "net" | "cout";

export function PayrollMatrix({
  year, rows, entites, colonnesMasse, moisCourant, futurDes, finFenetre,
}: {
  year: number;
  rows: PayrollRow[];
  /** Les entités de la paie (portée validée) — le sélecteur d'entité. */
  entites: { id: string; label: string }[];
  /** La masse salariale par entité, calculée par la page — le pied de la grille. */
  colonnesMasse: ColonneMasse[];
  /** Le mois courant quand l'année affichée est l'année en cours (surligné), sinon `null`. */
  moisCourant: number | null;
  /** Premier mois « à venir » (13 = aucun). */
  futurDes: number;
  /** Dernier mois de la fenêtre par défaut (6 mois). */
  finFenetre: number;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [paying, setPaying] = React.useState<{ row: PayrollRow; month: number } | null>(null);
  // CORRIGER une ligne déjà saisie : le même formulaire, prérempli avec ce qui a été enregistré.
  const [editing, setEditing] = React.useState<{ row: PayrollRow; month: number; cell: PayrollCell } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<Mode>("net");
  const [filtre, setFiltre] = React.useState("");
  const [anneeEntiere, setAnneeEntiere] = React.useState(false);

  const debut = Math.max(1, finFenetre - 5);
  const mois = anneeEntiere ? Array.from({ length: 12 }, (_, i) => i + 1) : Array.from({ length: 6 }, (_, i) => debut + i);
  const aSansEntite = rows.some((r) => !r.companyId);
  const lignes = rows.filter((r) => (
    filtre === "" ? true : filtre === FILTRE_SANS_ENTITE ? !r.companyId : r.companyId === filtre
  ));
  const masse = masseDuFiltre(colonnesMasse, filtre);
  const valeur = (c: PayrollCell): number | null => (mode === "net" ? c.net : (c.employerCost ?? c.amount));
  const valeurMasse = (m: { cost: number; net: number }) => (mode === "net" ? m.net : m.cost);

  async function undo(entryId: string) {
    const fd = new FormData(); fd.set("id", entryId);
    setBusy(true);
    let r: Awaited<ReturnType<typeof unmarkSalaryPaid>>;
    try {
      r = await unmarkSalaryPaid(fd);
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(false);
    }
    if (!r.ok) { setErr(r.error ?? "Le paiement n'a pas été annulé."); return; }
    setEditing(null);
    rafraichir();
  }

  const ouvrir = (row: PayrollRow, month: number) => {
    const cell = row.months[month - 1]!;
    setErr(null);
    if (cell.state === "UNPAID") setPaying({ row, month });
    else setEditing({ row, month, cell });
  };

  return (
    <section className="surface" aria-labelledby="grille-paie-titre">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3 sm:px-4">
        <h2 id="grille-paie-titre" className="text-sm font-semibold">
          {mode === "net" ? "Salaires nets" : "Coût employeur"} <span className="font-normal text-muted-foreground">· DZD</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Montant affiché" className="inline-flex rounded-lg border border-border bg-card p-0.5">
            {([["net", "Net"], ["cout", "Coût employeur"]] as const).map(([m, libelle]) => (
              <button
                key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                className={cn(
                  "min-h-8 rounded-md px-2.5 text-xs font-medium sm:min-h-7",
                  mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {libelle}
              </button>
            ))}
          </div>
          {(entites.length > 1 || aSansEntite) && (
            <Select value={filtre} onChange={(e) => setFiltre(e.target.value)} className="h-9 w-auto max-w-[12rem] text-xs sm:h-8" aria-label="Entité">
              <option value="">Toutes les entités</option>
              {entites.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              {aSansEntite && <option value={FILTRE_SANS_ENTITE}>Sans entité</option>}
            </Select>
          )}
          <Button type="button" variant="outline" size="sm" aria-pressed={anneeEntiere} onClick={() => setAnneeEntiere((v) => !v)}>
            {anneeEntiere ? "6 derniers mois" : "Toute l'année"}
          </Button>
        </div>
      </div>

      {/* La grille défile DANS ce cadre, jamais la page ; la colonne des noms reste collée à gauche. */}
      <div className="overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <th scope="col" className={cn(COLLEE, TEINTE, "px-3 py-2 text-left font-medium")}>Salarié</th>
              {mois.map((m) => (
                <th
                  key={m} scope="col"
                  className={cn("whitespace-nowrap px-2 py-2 text-right font-medium", m === moisCourant && "bg-primary/10 text-primary")}
                  aria-current={m === moisCourant ? "date" : undefined}
                >
                  {MONTHS[m - 1]}
                </th>
              ))}
              <th scope="col" className="whitespace-nowrap px-3 py-2 text-right font-medium">Total {year}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lignes.length === 0 && (
              <tr><td colSpan={mois.length + 2} className="px-3 py-6 text-center text-sm text-muted-foreground">Aucun salarié actif.</td></tr>
            )}
            {lignes.map((r) => {
              const total = r.months.reduce((a, c) => a + (c.state === "UNPAID" ? 0 : (valeur(c) ?? 0)), 0);
              return (
                <tr key={r.employeeId}>
                  <th scope="row" className={cn(COLLEE, "min-w-[10rem] max-w-[12rem] px-3 py-1.5 text-left font-normal sm:min-w-[13rem] sm:max-w-[16rem]")}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[0.6875rem] font-semibold text-primary">
                        {initials(r.name || "?")}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium" title={r.name}>{r.name}</span>
                        {r.poste && <span className="block truncate text-xs text-muted-foreground" title={r.poste}>{r.poste}</span>}
                      </span>
                    </span>
                  </th>
                  {mois.map((m) => {
                    const cell = r.months[m - 1]!;
                    const maintenant = m === moisCourant;
                    if (cell.state === "UNPAID") {
                      const futur = m >= futurDes;
                      return (
                        <td key={m} className={cn("px-1 py-1 text-center", maintenant && "bg-primary/5")}>
                          <button
                            type="button" disabled={enCours} onClick={() => ouvrir(r, m)}
                            title={futur ? `Saisir à l'avance — ${MONTHS[m - 1]} ${year}` : `Saisir le salaire — ${MONTHS[m - 1]} ${year}`}
                            className={cn(
                              "min-h-9 w-full rounded-md px-2 text-xs disabled:opacity-50 sm:min-h-8",
                              futur ? "text-muted-foreground/50 hover:bg-secondary hover:text-muted-foreground" : "font-medium text-primary hover:bg-primary/10",
                            )}
                          >
                            {futur ? "·" : "+ Saisir"}
                          </button>
                        </td>
                      );
                    }
                    const etat = ETAT_CELLULE[cell.state];
                    const v = valeur(cell);
                    return (
                      <td key={m} className={cn("px-1 py-1 text-right", maintenant && "bg-primary/5")}>
                        <button
                          type="button" disabled={enCours} onClick={() => ouvrir(r, m)}
                          title={`${etat.texte} — ${etat.titre}${cell.employerCost != null ? ` · Coût employeur ${formatCurrency(cell.employerCost)}` : ""}${cell.net != null ? ` · Net ${formatCurrency(cell.net)}` : ""}${cell.payslip ? " · fiche de paie jointe" : " · sans fiche de paie"}`}
                          className="inline-flex min-h-9 w-full items-center justify-end gap-1.5 whitespace-nowrap rounded-md px-2 tabular-nums hover:bg-secondary disabled:opacity-50 sm:min-h-8"
                        >
                          {cell.payslip && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
                          {formatMontant(v)}
                          <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", etat.point)} />
                          <span className="sr-only">{etat.texte}{cell.payslip ? ", fiche de paie jointe" : ", sans fiche de paie"}</span>
                        </button>
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted-foreground">{total > 0 ? formatMontant(total) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          {/* LA MASSE SALARIALE EN PIED — elle remplace la carte « par entité, mois par mois » et suit le
              filtre d'entité ; calculée par la page sur les salaires saisis (Direction, 04/10 puis 07/10). */}
          <tfoot>
            <tr className="border-t border-border bg-muted/40 font-semibold">
              <th scope="row" className={cn(COLLEE, TEINTE, "px-3 py-2 text-left")}>Masse salariale</th>
              {mois.map((m) => {
                const x = valeurMasse(masse.mois[m - 1]!);
                return (
                  <td key={m} className={cn("whitespace-nowrap px-3 py-2 text-right tabular-nums", m === moisCourant && "bg-primary/10", x === 0 && "font-normal text-muted-foreground")}>
                    {x === 0 ? "—" : formatMontant(x)}
                  </td>
                );
              })}
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{valeurMasse(masse.total) === 0 ? "—" : formatMontant(valeurMasse(masse.total))}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground sm:px-4">
        {(["SAISI", "ENVOYE", "VIRE"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("h-2 w-2 rounded-full", ETAT_CELLULE[s].point)} /> {ETAT_CELLULE[s].texte}
          </span>
        ))}
        <span>Cliquer un montant : corriger, voir la fiche de paie</span>
        <InfoBulle label="Règles de la saisie" align="left">
          Un salaire saisi s&apos;annule tant que la paie de son entité n&apos;est pas envoyée ; ensuite il se corrige,
          et l&apos;envoi garde la somme déclarée. Le trombone signale une fiche de paie jointe. Le salarié est prévenu
          au virement, jamais moins de 24 h après la saisie. La masse salariale compte les salaires saisis.
        </InfoBulle>
      </div>

      {/* Saisir : coût employeur, net, brut, fiche de paie */}
      <Sheet
        open={paying !== null}
        onClose={() => !busy && setPaying(null)}
        title={paying ? `Saisir la paie — ${paying.row.name}` : ""}
        description={paying ? `${formatMonth(ym(year, paying.month))} · prévenu au virement de son entité` : undefined}
        width="md"
      >
        {paying && (
          <form
            action={async (fd) => {
              setBusy(true); setErr(null);
              fd.set("employeeId", paying.row.employeeId);
              fd.set("year", String(year));
              fd.set("month", String(paying.month));
              let r: Awaited<ReturnType<typeof markSalaryPaid>>;
              try {
                r = await markSalaryPaid(fd);
              } catch {
                setErr(actionFailureMessage("THROWN"));
                return;
              } finally {
                setBusy(false);
              }
              if (r.ok) { setPaying(null); rafraichir(); } else setErr(r.error ?? "Le salaire n'a pas été marqué payé.");
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* LE COÛT EMPLOYEUR REMPLACE LE BRUT comme montant obligatoire : c'est ce que la
                  société décaisse réellement, et donc ce qui pèse sur le budget et fait la masse
                  salariale. Le brut, lui, n'est qu'une ligne du bulletin. */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label htmlFor="pay-cost">Coût employeur (DZD) <span className="text-destructive">*</span></Label>
                  <InfoBulle label="Le coût employeur" align="left">
                    Brut + charges patronales : le total imputé au budget, et la brique de la masse salariale.
                    Pré-rempli depuis la fiche employé — modifiable.
                  </InfoBulle>
                </div>
                <Input id="pay-cost" name="employerCost" type="number" inputMode="decimal" step="any" min="1" required defaultValue={paying.row.defaultEmployerCost ?? undefined} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pay-net">Salaire net (DZD) <span className="text-destructive">*</span></Label>
                <Input id="pay-net" name="net" type="number" inputMode="decimal" step="any" min="1" required defaultValue={paying.row.defaultNet ?? undefined} />
                <p className="text-xs text-muted-foreground">Affiché au salarié · au plus le coût employeur.</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex items-center gap-1">
                  <Label htmlFor="pay-gross">Salaire brut (DZD) <span className="text-xs font-normal text-muted-foreground">(facultatif)</span></Label>
                  <InfoBulle label="Le salaire brut" align="left">
                    Information de bulletin. Laissé vide, il est repris du coût employeur — il n&apos;entre pas dans le calcul du budget.
                  </InfoBulle>
                </div>
                <Input id="pay-gross" name="gross" type="number" inputMode="decimal" step="any" min="0" defaultValue={paying.row.defaultGross ?? undefined} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-file">Fiche de paie <span className="text-xs font-normal text-muted-foreground">(facultatif)</span></Label>
              <input id="pay-file" name="payslip" type="file" className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
            </div>
            {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setPaying(null)} disabled={busy}>Annuler</Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer la saisie</Button>
            </div>
          </form>
        )}
      </Sheet>

      {/* CORRIGER une ligne déjà saisie — le même formulaire, prérempli. Une paie fausse ne se rattrape
          pas au mois suivant : elle se corrige, même envoyée — le virement, lui, porte la somme déclarée
          à l'envoi (§118.176). La fiche de paie du mois se voit ici, et l'annulation d'une saisie aussi. */}
      <Sheet
        open={editing !== null}
        onClose={() => !busy && setEditing(null)}
        title={editing ? `Corriger la paie — ${editing.row.name}` : ""}
        description={editing
          ? `${formatMonth(ym(year, editing.month))} · ${ETAT_CELLULE[editing.cell.state === "UNPAID" ? "SAISI" : editing.cell.state].texte.toLowerCase()}${editing.cell.state === "VIRE" || editing.cell.state === "ENVOYE" ? " · la somme déclarée au centre ne change pas" : ""}`
          : undefined}
        width="md"
      >
        {editing && (
          <form
            action={async (fd) => {
              setBusy(true); setErr(null);
              fd.set("id", editing.cell.entryId ?? "");
              let r: Awaited<ReturnType<typeof updatePayrollEntry>>;
              try {
                r = await updatePayrollEntry(fd);
              } catch {
                setErr(actionFailureMessage("THROWN"));
                return;
              } finally {
                setBusy(false);
              }
              if (r.ok) { setEditing(null); rafraichir(); } else setErr(r.error ?? "La ligne de paie n'a pas été modifiée.");
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label htmlFor="edit-cost">Coût employeur (DZD) <span className="text-destructive">*</span></Label>
                  <InfoBulle label="Le coût employeur" align="left">Le total imputé au budget. Le corriger corrige la masse salariale.</InfoBulle>
                </div>
                <Input
                  id="edit-cost" name="employerCost" type="number" inputMode="decimal" step="any" min="1" required
                  defaultValue={editing.cell.employerCost ?? editing.cell.amount ?? undefined}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-net">Salaire net (DZD) <span className="text-destructive">*</span></Label>
                <Input id="edit-net" name="net" type="number" inputMode="decimal" step="any" min="1" required defaultValue={editing.cell.net ?? undefined} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="edit-gross">Salaire brut (DZD) <span className="text-xs font-normal text-muted-foreground">(facultatif)</span></Label>
                <Input id="edit-gross" name="gross" type="number" inputMode="decimal" step="any" min="0" defaultValue={editing.cell.amount ?? undefined} />
              </div>
            </div>
            <div className="space-y-1.5">
              {/* CE QUI EST DÉJÀ LÀ, AVANT CE QU'ON PEUT METTRE : sans lui, on rejoignait le même bulletin
                  une seconde fois, sans savoir qu'on écrasait le premier. */}
              {editing.cell.payslip ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs">
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <DocumentPreview
                    id={editing.cell.payslip.id}
                    name={editing.cell.payslip.name}
                    hasFile
                    srcOverride={`/api/rh/document/${editing.cell.payslip.id}`}
                  />
                  <span className="text-muted-foreground">
                    déposée le {new Date(editing.cell.payslip.addedAt).toLocaleDateString("fr-FR")}
                    {editing.cell.payslip.sizeBytes != null ? ` · ${formatBytes(editing.cell.payslip.sizeBytes)}` : ""}
                  </span>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-warning/50 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                  Sans fiche de paie pour ce mois.
                </p>
              )}
              <div className="flex items-center gap-1">
                <Label htmlFor="edit-file">
                  {editing.cell.payslip ? "Remplacer la fiche de paie" : "Déposer la fiche de paie"}{" "}
                  <span className="text-xs font-normal text-muted-foreground">(facultatif)</span>
                </Label>
                <InfoBulle label="La fiche de paie" align="left">
                  {editing.cell.payslip
                    ? "La nouvelle prend la place de l'ancienne dans le dossier du salarié — deux bulletins pour le même mois lui laisseraient deviner lequel fait foi."
                    : "Elle sera déposée dans le dossier RH du salarié, visible par lui, et restera rattachée à ce mois."}
                </InfoBulle>
              </div>
              <input id="edit-file" name="payslip" type="file" className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
            </div>
            {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              {editing.cell.state === "SAISI" && editing.cell.entryId && (
                <AnnulerLaSaisie
                  cell={editing.cell} disabled={busy || enCours} undo={undo}
                  confirmation={`annuler la saisie de ${editing.row.name} pour ${formatMonth(ym(year, editing.month))}`}
                />
              )}
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setEditing(null)} disabled={busy}>Fermer</Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy || enCours}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer la correction</Button>
            </div>
          </form>
        )}
      </Sheet>
    </section>
  );
}

/**
 * ANNULER UNE SAISIE — tant que la paie de l'entité n'est pas envoyée (`SAISI`). Le geste vivait au
 * survol de la case ; il est maintenant dans la fiche de correction, qu'ouvre un clic sur le montant.
 */
function AnnulerLaSaisie({ cell, confirmation, disabled, undo }: {
  cell: PayrollCell;
  confirmation: string;
  disabled: boolean;
  undo: (entryId: string) => void;
}) {
  return (
    <BoutonDecisif brut type="button"
      confirmation={confirmation}
      disabled={disabled}
      onClick={() => undo(cell.entryId!)}
      className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md px-3 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 sm:mr-auto"
    >
      <Undo2 className="h-3.5 w-3.5" /> Annuler la saisie
    </BoutonDecisif>
  );
}
