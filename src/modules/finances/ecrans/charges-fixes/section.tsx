"use client";

import * as React from "react";
import { Building, FileText, Loader2, Pencil, Plus, ScanLine } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type { BadgeTone } from "@/lib/labels";
import {
  demanderPaiementChargeFixe, enregistrerChargeFixe, libererReserveImprevus, retirerChargeFixe,
} from "@/modules/finances/actions-charges-fixes";
import { lireFactureDepense } from "@/lib/actions/department-budget-actions";
import {
  CLE_RESERVE_IMPREVUS, ecartFacture, LIBELLE_ETAT_ECHEANCE, LIBELLE_MODE_MONTANT, LIBELLE_NATURE_CHARGE_FIXE,
  LIBELLE_PERIODICITE_CHARGE, NATURES_CHARGE_FIXE, PERIODICITES_CHARGE, peutDemanderPaiement, TON_ETAT_ECHEANCE,
  type ChargeVue, type EcheanceVue, type SocieteChargesVue,
} from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « INFORMATIONS DE LA SOCIÉTÉ › LOCAUX & CHARGES FIXES » (Super Admin, 24/11/2026).
 *
 * Trois blocs, dans l'ordre où on les lit : les charges de la société (par site), leurs échéances proches avec leur état
 * (lu sur l'ordre de paiement), le budget de l'Administration qu'elles alimentent. Les Finances y joignent la facture
 * d'une échéance et en demandent le paiement ; le centre de paiement décide, Banque & paiements paie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DroitsChargesFixes {
  /** Saisir les charges (Finances › Modifier, ou Legal › Modifier). */
  saisir: boolean;
  /** Demander le paiement d'une échéance (les Finances). */
  payer: boolean;
  /** Libérer la réserve pour imprévus (DG, Super Admin). */
  liberer: boolean;
}

const CARTE_ETAT: Record<string, { label: string; tone: BadgeTone }> = Object.fromEntries(
  Object.entries(LIBELLE_ETAT_ECHEANCE).map(([k, label]) => [k, { label, tone: TON_ETAT_ECHEANCE[k as keyof typeof TON_ETAT_ECHEANCE] }]),
);

const quand = (e: EcheanceVue): string =>
  e.joursAvant < 0 ? `en retard de ${-e.joursAvant} j` : e.joursAvant === 0 ? "aujourd'hui" : `dans ${e.joursAvant} j`;

export function ChargesFixesSection({
  companyId, societe, vue, droits, echeanceCible,
}: {
  companyId: string;
  societe: string;
  vue: SocieteChargesVue;
  droits: DroitsChargesFixes;
  echeanceCible: string | null;
}) {
  const [edition, setEdition] = React.useState<ChargeVue | "nouvelle" | null>(null);
  const [paiement, setPaiement] = React.useState<EcheanceVue | null>(null);
  const [reserve, setReserve] = React.useState(false);
  const actives = vue.charges.filter((c) => c.active);
  const retirees = vue.charges.filter((c) => !c.active);

  // Arrivé par « Aujourd'hui » ou une notification : le panneau de paiement de l'échéance désignée s'ouvre seul.
  React.useEffect(() => {
    if (!echeanceCible || !droits.payer) return;
    const e = vue.echeances.find((x) => x.cle === echeanceCible);
    if (e && peutDemanderPaiement(e.etat)) setPaiement(e);
  }, [echeanceCible, droits.payer, vue.echeances]);

  return (
    <section id="charges-fixes" className="surface scroll-mt-20 space-y-4 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Building className="h-4 w-4 text-primary" /> Locaux & charges fixes
        </h2>
        {droits.saisir && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEdition("nouvelle")}>
            <Plus className="h-4 w-4" /> Ajouter une charge
          </Button>
        )}
      </div>

      {actives.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune charge fixe pour {societe}.{droits.saisir ? " Ajoutez le loyer et les charges de chaque local." : " Les Finances les renseignent ici."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {actives.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {c.natureLibelle}{c.libelle ? ` — ${c.libelle}` : ""} <span className="text-muted-foreground">· {c.site}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.beneficiaire}{c.rib ? ` · RIB ${c.rib}` : ""}{c.bail ? ` · ${c.bail}` : ""}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="tabular-nums">
                  {formatCurrency(c.montant)}
                  {c.modeMontant === "SELON_FACTURE" && <span className="ml-1 text-xs text-muted-foreground">estimation</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {LIBELLE_PERIODICITE_CHARGE[c.periodicite as keyof typeof LIBELLE_PERIODICITE_CHARGE] ?? c.periodicite} · le {c.jourEcheance}
                  {" · "}{formatCurrency(c.montantAnnuel)} / an
                </p>
              </div>
              {droits.saisir && (
                <Button size="sm" variant="ghost" aria-label={`Modifier ${c.natureLibelle} — ${c.site}`} onClick={() => setEdition(c)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {retirees.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Retirées : {retirees.map((c) => `${c.natureLibelle} — ${c.site}`).join(", ")}.
        </p>
      )}

      {vue.echeances.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Échéances</h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {vue.echeances.map((e) => (
              <li
                key={e.cle}
                className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2", e.cle === echeanceCible && "bg-primary/5")}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{e.nature} — {e.site} · {e.periodeLibelle}</p>
                  <p className="text-xs text-muted-foreground">
                    dû le {formatDate(e.date)} ({quand(e)}){e.reference ? ` · ${e.reference}` : ""}
                  </p>
                </div>
                <span className="text-sm tabular-nums">
                  {formatCurrency(e.montantFacture ?? e.montantPrevu)}
                  {e.montantFacture === null && e.modeMontant === "SELON_FACTURE" && <span className="ml-1 text-xs text-muted-foreground">estimation</span>}
                </span>
                <StatusBadge map={CARTE_ETAT} value={e.etat} />
                {droits.payer && peutDemanderPaiement(e.etat) && (
                  <Button size="sm" onClick={() => setPaiement(e)}>
                    <FileText className="h-4 w-4" /> Demander le paiement
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {vue.budget && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Budget — {vue.budget.nom} · {formatCurrency(vue.budget.total)}
            </h3>
            {droits.liberer && (vue.budget.lignes.find((l) => l.cle === CLE_RESERVE_IMPREVUS)?.alloue ?? 0) > 0 && (
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setReserve(true)}>Libérer la réserve</Button>
            )}
          </div>
          <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {vue.budget.lignes.filter((l) => !l.sous).map((l) => (
              <div key={l.id} className="flex items-baseline justify-between gap-2 border-b border-border py-1">
                <dt className="text-sm">{l.nom}</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(l.alloue)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {edition && (
        <ChargeSheet companyId={companyId} charge={edition === "nouvelle" ? null : edition} baux={vue.baux} onClose={() => setEdition(null)} />
      )}
      {paiement && <PaiementSheet echeance={paiement} onClose={() => setPaiement(null)} />}
      {reserve && vue.budget && <ReserveSheet budget={vue.budget} onClose={() => setReserve(false)} />}
    </section>
  );
}

const iso = (d: string | null | undefined) => (d ? d.slice(0, 10) : "");

function ChargeSheet({ companyId, charge, baux, onClose }: {
  companyId: string; charge: ChargeVue | null; baux: SocieteChargesVue["baux"]; onClose: () => void;
}) {
  const { busy, err, run } = useAction();
  const [periodicite, setPeriodicite] = React.useState(charge?.periodicite ?? "MENSUELLE");
  const [mode, setMode] = React.useState(charge?.modeMontant ?? "FIXE");
  const [nature, setNature] = React.useState(charge?.nature ?? "LOYER");

  async function enregistrer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("companyId", companyId);
    if (charge) fd.set("id", charge.id);
    fd.set("echeanceFixe", (e.currentTarget.elements.namedItem("echeanceFixe") as HTMLInputElement | null)?.checked ? "true" : "false");
    await run(() => enregistrerChargeFixe(fd), onClose, { succes: charge ? "Charge enregistrée." : "Charge ajoutée." });
  }

  return (
    <Sheet open onClose={onClose} width="lg" title={charge ? `${charge.natureLibelle} — ${charge.site}` : "Nouvelle charge fixe"}>
      <form onSubmit={enregistrer} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cf-site">Site ou local</Label>
            <Input id="cf-site" name="site" required defaultValue={charge?.site ?? ""} placeholder="Siège — Alger" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-nature">Nature</Label>
            <Select id="cf-nature" name="nature" value={nature} onChange={(e) => setNature(e.target.value)}>
              {NATURES_CHARGE_FIXE.map((n) => <option key={n} value={n}>{LIBELLE_NATURE_CHARGE_FIXE[n]}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-benef">Bénéficiaire</Label>
            <Input id="cf-benef" name="beneficiaire" required defaultValue={charge?.beneficiaire ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-rib">RIB</Label>
            <Input id="cf-rib" name="rib" defaultValue={charge?.rib ?? ""} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cf-bail">Bail ou contrat (registre Legal)</Label>
            <Select id="cf-bail" name="legalDocumentId" defaultValue={charge?.legalDocumentId ?? ""}>
              <option value="">Aucun</option>
              {baux.map((b) => <option key={b.id} value={b.id}>{b.titre}{b.montant ? ` · ${formatCurrency(b.montant)}` : ""}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-mode">Montant</Label>
            <Select id="cf-mode" name="modeMontant" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="FIXE">{LIBELLE_MODE_MONTANT.FIXE}</option>
              <option value="SELON_FACTURE">{LIBELLE_MODE_MONTANT.SELON_FACTURE}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-montant">{mode === "SELON_FACTURE" ? "Estimation par échéance (DZD)" : "Montant par échéance (DZD)"}</Label>
            <Input id="cf-montant" name="montant" inputMode="decimal" required defaultValue={charge ? String(charge.montant) : ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-per">Périodicité</Label>
            <Select id="cf-per" name="periodicite" value={periodicite} onChange={(e) => setPeriodicite(e.target.value)}>
              {PERIODICITES_CHARGE.map((p) => <option key={p} value={p}>{LIBELLE_PERIODICITE_CHARGE[p]}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-jour">Jour d&apos;échéance</Label>
              <Input id="cf-jour" name="jourEcheance" type="number" min={1} max={31} required defaultValue={charge?.jourEcheance ?? 5} />
            </div>
            {periodicite !== "MENSUELLE" && (
              <div className="space-y-1.5">
                <Label htmlFor="cf-mois">Mois (1re échéance)</Label>
                <Input id="cf-mois" name="moisEcheance" type="number" min={1} max={12} defaultValue={charge?.moisEcheance ?? ""} />
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-debut">Début</Label>
            <Input id="cf-debut" name="dateDebut" type="date" required defaultValue={iso(charge?.dateDebut)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-fin">Fin (vide : sans fin)</Label>
            <Input id="cf-fin" name="dateFin" type="date" defaultValue={iso(charge?.dateFin)} />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="echeanceFixe" defaultChecked={charge ? charge.echeanceFixe : nature === "LOYER"} key={charge ? "c" : nature} />
            Échéance fixe (ne se reporte pas sans motif)
          </label>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cf-notes">Notes</Label>
            <Textarea id="cf-notes" name="notes" rows={2} defaultValue={charge?.notes ?? ""} />
          </div>
        </div>
        {err && <Retour ton="erreur">{err}</Retour>}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          {charge && <RetirerCharge id={charge.id} onDone={onClose} />}
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
        </div>
      </form>
    </Sheet>
  );
}

function RetirerCharge({ id, onDone }: { id: string; onDone: () => void }) {
  const { busy, err, run } = useAction({ signalerErreurs: true });
  return (
    <BoutonDecisif
      type="button" variant="outline" className="sm:mr-auto" disabled={busy} confirmation="Retirer cette charge"
      onClick={() => { const fd = new FormData(); fd.set("id", id); void run(() => retirerChargeFixe(fd), onDone, { succes: "Charge retirée." }); }}
      title={err ?? undefined}
    >
      Retirer la charge
    </BoutonDecisif>
  );
}

function PaiementSheet({ echeance, onClose }: { echeance: EcheanceVue; onClose: () => void }) {
  const { busy, err, run, setErr } = useAction();
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [montant, setMontant] = React.useState(String(echeance.montantPrevu));
  const [lecture, setLecture] = React.useState<"idle" | "lecture" | "lu">("idle");
  const valeur = Number(montant.replace(/\s| /g, "").replace(",", "."));
  const alerte = Number.isFinite(valeur) ? ecartFacture({ modeMontant: echeance.modeMontant, prevu: echeance.montantPrevu, facture: valeur }) : null;

  async function lire() {
    if (!fichier) return;
    setLecture("lecture");
    const fd = new FormData();
    fd.set("fichier", fichier);
    const r = await lireFactureDepense(fd).catch(() => null);
    const total = r && r.ok ? r.lecture?.totalImprime ?? null : null;
    if (total && total > 0) setMontant(String(total));
    else setErr(r && !r.ok ? r.error ?? "Facture illisible : saisissez le montant." : "Aucun total lu sur la facture : saisissez le montant.");
    setLecture("lu");
  }

  async function envoyer() {
    if (!fichier) { setErr("Joignez la facture : sans justificatif, le paiement n'entre pas au centre de paiement."); return; }
    const fd = new FormData();
    fd.set("chargeId", echeance.chargeId);
    fd.set("periode", echeance.periode);
    fd.set("montant", montant);
    fd.set("facture", fichier);
    await run(() => demanderPaiementChargeFixe(fd), onClose, { succes: "Paiement demandé au centre de paiement." });
  }

  return (
    <Sheet open onClose={onClose} title={`${echeance.nature} — ${echeance.site} · ${echeance.periodeLibelle}`}>
      <div className="space-y-3">
        <p className="text-sm">
          {echeance.beneficiaire} · dû le {formatDate(echeance.date)} · {echeance.modeMontant === "SELON_FACTURE" ? "estimation" : "montant fixe"} {formatCurrency(echeance.montantPrevu)}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="cf-facture">Facture</Label>
          <Input id="cf-facture" type="file" accept="application/pdf,image/*" onChange={(e) => { setFichier(e.target.files?.[0] ?? null); setLecture("idle"); }} />
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="cf-montant-facture">Montant de la facture (DZD)</Label>
            <Input id="cf-montant-facture" inputMode="decimal" value={montant} onChange={(e) => setMontant(e.target.value)} />
          </div>
          <Button type="button" variant="outline" disabled={!fichier || lecture === "lecture"} onClick={() => void lire()}>
            {lecture === "lecture" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />} Lire le montant
          </Button>
        </div>
        {alerte && <Retour ton="alerte">{alerte.titre} — {alerte.detail}. Le centre de paiement le verra.</Retour>}
        {err && <Retour ton="erreur">{err}</Retour>}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <BoutonDecisif type="button" disabled={busy || !fichier} onClick={() => void envoyer()} confirmation="Demander le paiement">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Demander le paiement
          </BoutonDecisif>
        </div>
      </div>
    </Sheet>
  );
}

function ReserveSheet({ budget, onClose }: { budget: NonNullable<SocieteChargesVue["budget"]>; onClose: () => void }) {
  const { busy, err, run } = useAction();
  const reserve = budget.lignes.find((l) => l.cle === CLE_RESERVE_IMPREVUS);
  const cibles = budget.lignes.filter((l) => !l.sous && l.cle !== CLE_RESERVE_IMPREVUS);

  async function liberer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("envelopeId", budget.id);
    await run(() => libererReserveImprevus(fd), onClose, { succes: "Réserve libérée." });
  }

  return (
    <Sheet open onClose={onClose} title="Libérer la réserve pour imprévus">
      <form onSubmit={liberer} className="space-y-3">
        <p className="text-sm">Disponible : {formatCurrency(reserve?.alloue ?? 0)}</p>
        <div className="space-y-1.5">
          <Label htmlFor="cf-cible">Vers la ligne</Label>
          <Select id="cf-cible" name="cibleId" required defaultValue="">
            <option value="" disabled>Choisir…</option>
            {cibles.map((l) => <option key={l.id} value={l.id}>{l.nom}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cf-reserve-montant">Montant (DZD)</Label>
          <Input id="cf-reserve-montant" name="montant" inputMode="decimal" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cf-motif">Motif</Label>
          <Input id="cf-motif" name="motif" required />
        </div>
        {err && <Retour ton="erreur">{err}</Retour>}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <BoutonDecisif disabled={busy} confirmation="Libérer la réserve">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Libérer</BoutonDecisif>
        </div>
      </form>
    </Sheet>
  );
}
